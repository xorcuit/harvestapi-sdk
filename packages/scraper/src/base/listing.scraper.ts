import { randomUUID } from 'crypto';
import fs from 'fs-extra';
import { dirname, resolve } from 'path';
import type { Database } from 'sqlite';
import { ApiItemResponse, ApiListResponse } from '../types';
import { createConcurrentQueues } from '../utils';
import { ListingScraperOptions } from './types';

export class ListingScraper<TItemShort extends { id: string }, TItemDetail extends { id: string }> {
  private id = randomUUID();
  private startTime = new Date();
  private inMemoryItems: TItemDetail[] = [];
  private stats = {
    pages: 0,
    pagesSuccess: 0,
    items: 0,
    itemsSuccess: 0,
    requests: 0,
    requestsStartTime: new Date(),
  };
  private filePath: string;
  private db: Database | null = null;
  private tableName: string;
  private sqliteDatabaseOpenPromise: Promise<void> | null = null;
  private done = false;
  private error: any | null = null;

  constructor(private options: ListingScraperOptions<TItemShort, TItemDetail>) {
    if (!this.options.outputType) {
      this.options.outputType = 'sqlite';
    }

    this.tableName = this.options.tableName || `${this.options.entityName}_${this.id}`;
    this.filePath = resolve(
      this.options.outputDir || resolve(process.cwd(), 'output'),
      this.options.filename ||
        `${this.startTime.toISOString().replace(/:/g, '-').replace(/\./g, '-')}_${
          this.options.entityName
        }_${this.id}`,
    );
  }

  private scrapePageQueue!: (args: {
    page: number;
    scrapedList?: ApiListResponse<TItemShort>;
  }) => Promise<void>;

  async scrapeStart() {
    const firstPage = await this.fetchPage({ page: 1 });

    let totalPages = firstPage?.pagination?.totalPages || 0;
    if (this.options.maxPages && totalPages > this.options.maxPages) {
      totalPages = this.options.maxPages;
    }

    const concurrency = firstPage?.user?.requestsConcurrency || 1;

    console.info(
      `Scraping ${this.options.entityName} with ${concurrency} concurrent ${
        concurrency === 1 ? 'worker' : 'workers'
      }... Total pages: ${totalPages}`,
    );

    if (!firstPage || !totalPages) {
      this.done = true;
      if (this.error) {
        const errors = Array.isArray(this.error) ? this.error : [this.error];
        console.error(...errors);
      }
      console.error('Error fetching first page or no items found. Exiting.');
      return;
    }

    this.scrapePageQueue = createConcurrentQueues(concurrency, (args) => this.scrapePage(args));
    this.stats.requestsStartTime = new Date();
    this.stats.pages = 1;
    this.stats.pagesSuccess = 1;

    if (this.options.outputType === 'sqlite') {
      this.sqliteDatabaseOpenPromise = this.createSqliteDatabase();
    }

    const promises: Promise<void>[] = [];
    for (let page = 1; page <= totalPages; page++) {
      promises.push(
        this.scrapePageQueue({ page, scrapedList: page === 1 ? firstPage : undefined }),
      );
    }

    await Promise.all(promises);
    await this.finalize();

    console.info(
      `Finished scraping ${this.options.entityName}. Scraped pages: ${this.stats.pages}. Scraped items: ${this.stats.itemsSuccess}. Total requests: ${this.stats.requests}.`,
    );

    if (this.error) {
      const errors = Array.isArray(this.error) ? this.error : [this.error];
      console.error(...errors);
    }

    return this.stats;
  }

  private async scrapePage({
    page,
    scrapedList,
  }: {
    page: number;
    scrapedList?: ApiListResponse<TItemShort>;
  }) {
    if (this.done) return;
    const list = scrapedList ? scrapedList : await this.fetchPage({ page });
    if (this.done) return;

    let details: TItemDetail[] = [];

    if (list?.elements) {
      details = await this.scrapePageItems({ list });
    }
    if (this.done) return;

    console.info(
      `Scraped ${this.options.entityName} page ${page}. Items found: ${
        details.length
      }. Requests/second: ${(
        this.stats.requests /
        ((Date.now() - this.stats.requestsStartTime.getTime()) / 1000)
      ).toFixed(2)}`,
    );
  }

  private async fetchPage({ page }: { page: number }) {
    const result = await this.options.fetchList({ page }).catch((error) => {
      console.error('Error fetching page', page, error);
      return null;
    });
    if (result?.status === 402) {
      this.done = true;
      this.error = result.error || 'Request limit exceeded - upgrade your plan';
      return null;
    }
    this.stats.pages++;
    this.stats.requests++;
    if (result?.id) {
      this.stats.pagesSuccess++;
    }
    return result;
  }

  private async scrapePageItems({ list }: { list: ApiListResponse<TItemShort> }) {
    if (!list?.elements) {
      return [];
    }

    const details: TItemDetail[] = [];

    for (const item of list.elements) {
      let itemDetails:
        | (Partial<ApiItemResponse<TItemDetail>> & { skipped?: boolean })
        | null
        | undefined = null;

      if (this.options.scrapeDetails) {
        itemDetails = await this.options.fetchItem({ item })?.catch((error) => {
          console.error('Error scraping item', error);
          return null;
        });

        if (itemDetails?.status === 402) {
          this.done = true;
          this.error = itemDetails?.error || 'Request limit exceeded - upgrade your plan';
          return details;
        }
      } else {
        itemDetails = {
          id: item?.id,
          element: item as any,
          status: list.status,
          error: list.error,
          query: list.query,
        };
      }

      this.stats.items++;

      if (this.options.scrapeDetails && !itemDetails?.skipped) {
        this.stats.requests++;
      }

      if (itemDetails?.element && itemDetails.id) {
        this.stats.itemsSuccess++;
        await this.onItemScraped({ item: itemDetails.element });
        details.push(itemDetails.element);
      }
    }

    return details;
  }

  private onItemScraped = createConcurrentQueues(1, async ({ item }: { item: TItemDetail }) => {
    if (this.options.outputType === 'json') {
      this.inMemoryItems.push(item);
    }
    if (this.options.outputType === 'sqlite') {
      await this.insertSqliteItem(item).catch((error) => {
        console.error('Error inserting item to SQLite:', error);
      });
    }
  });

  private async createSqliteDatabase() {
    try {
      const open = require('sqlite').open; // eslint-disable-line @typescript-eslint/no-require-imports
      const sqlite3 = require('sqlite3'); // eslint-disable-line @typescript-eslint/no-require-imports

      await fs.ensureDir(dirname(this.filePath));

      this.db = await open({
        filename: `${this.filePath}.sqlite`,
        driver: sqlite3.Database,
      });

      await this.db!.exec(
        `CREATE TABLE IF NOT EXISTS "${this.tableName}" (db_id INTEGER PRIMARY KEY AUTOINCREMENT)`,
      );
    } catch (error) {
      this.error = ['Error creating SQLite database:', error];
      this.done = true;
    }
  }

  private async insertSqliteItem(item: TItemDetail) {
    await this.sqliteDatabaseOpenPromise;

    const existingColumns = await this.db!.all(`PRAGMA table_info("${this.tableName}")`);
    const existingColumnNames = existingColumns.map((col) => col.name);

    for (const key of Object.keys(item as any)) {
      if (!existingColumnNames.includes(key)) {
        await this.db!.exec(`ALTER TABLE "${this.tableName}" ADD COLUMN "${key}" TEXT`);
      }
    }

    const keys = Object.keys(item as any)
      .map((key) => key)
      .map((key) => `"${key}"`);

    const insertSQL = `INSERT INTO "${this.tableName}" (${keys.join(', ')}) VALUES (${keys
      .map(() => '?')
      .join(', ')})`;

    await this.db!.run(
      insertSQL,
      Object.values(item as any).map((value) =>
        typeof value === 'object' ? JSON.stringify(value) : String(value),
      ),
    );
  }

  private async finalize() {
    if (this.options.outputType === 'json') {
      fs.outputJson(
        `${this.filePath}.json`,
        {
          stats: this.stats,
          list: this.inMemoryItems,
        },
        { spaces: 2 },
      );
    }

    if (this.db) {
      await this.db.close();
    }
  }
}
