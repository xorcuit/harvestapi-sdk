require('dotenv').config();

import { LinkedinScraper } from './scraper';

if (!process.env.API_KEY) {
  throw new Error('API_KEY env variable is required');
}

const scraper = new LinkedinScraper({
  apiKey: process.env.API_KEY!,
  basePath: 'http://localhost:3552/api',
});

describe('Linkedin API', () => {
  it('getCompany google', async () => {
    const data = await scraper.getCompany({
      universalName: 'google',
    });

    expect(data.element.id).toBe('1441');
    expect(data.element.name).toBe('Google');
  });

  it('searchCompanies google', async () => {
    const data = await scraper.searchCompanies({
      search: 'Google',
      location: 'Germany',
      page: 1,
    });

    expect(data.elements.length).toBeGreaterThan(0);
    expect(data.elements[0].name).toBe('Google');
    expect(data.elements[0].universalName).toBe('google');
  });

  it('searchCompanies google small size', async () => {
    const data = await scraper.searchCompanies({
      search: 'Google',
      location: 'Germany',
      companySize: '1-10',
    });

    expect(data.elements.length).toBeGreaterThan(0);
    expect(data.elements[0].universalName).not.toBe('google');
  });
});
