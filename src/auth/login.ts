import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';

const CONFIG_DIR = path.join(os.homedir(), '.sainsburys');
const SESSION_FILE = path.join(CONFIG_DIR, 'session.json');

export interface SessionData {
  cookies: any[];
  expiresAt: string;
  lastLogin: string;
}

export interface LoginOptions {
  /**
   * Run the browser headless (for automatic re-auth). Progress logs go to
   * stderr so JSON on stdout stays clean, and an MFA challenge fails fast
   * instead of prompting — MFA needs an interactive `groc login`.
   */
  headless?: boolean;
}

export async function login(email: string, password: string, options: LoginOptions = {}): Promise<SessionData> {
  try {
    return await browserLogin(email, password, options);
  } catch {
    // Playwright exceptions can include credentials in fill() action logs.
    // Do not retain the original error (including as a cause).
    throw new Error('Sainsbury\'s authentication failed. Run `supermarket login --provider sainsburys` interactively to check credentials and complete any MFA.');
  }
}

async function browserLogin(email: string, password: string, options: LoginOptions): Promise<SessionData> {
  const headless = options.headless ?? false;
  const log = headless ? console.error : console.log;
  log('🔐 Logging in to Sainsbury\'s...');

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
  });
  
  const page = await context.newPage();
  
  try {
    // Go to login page (OAuth endpoint)
    log('📍 Navigating to login page...');
    await page.goto('https://www.sainsburys.co.uk/gol-ui/oauth/login', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    
    // Handle cookie consent if present
    try {
      log('🍪 Checking for cookie consent...');
      const acceptButton = page.locator('#onetrust-accept-btn-handler');
      if (await acceptButton.isVisible({ timeout: 3000 })) {
        log('🍪 Accepting cookies...');
        await acceptButton.click();
        log('🍪 Waiting for banner to dismiss...');
        await page.waitForTimeout(3000);
        // Wait for overlay to disappear
        await page.waitForSelector('#onetrust-consent-sdk.ot-hide, .onetrust-pc-dark-filter.ot-hide', { timeout: 5000 }).catch(() => {});
      }
    } catch (e) {
      log('🍪 No cookie consent found or already accepted');
    }
    
    // Wait for login form to appear
    log('⏳ Waiting for login form...');
    await page.waitForSelector('input[type="email"], input[name="email"], #username', { timeout: 10000 });
    
    // Fill in email
    log('📧 Entering email...');
    await page.fill('input[type="email"], input[name="email"], #username', email);
    await page.waitForTimeout(500);
    
    // Fill in password
    log('🔑 Entering password...');
    await page.fill('input[type="password"], input[name="password"], #password', password);
    await page.waitForTimeout(500);
    
    // Force remove any cookie overlays blocking interactions
    log('🧹 Removing cookie overlays...');
    // @ts-ignore - runs in browser context
    await page.evaluate(() => {
      // @ts-ignore
      const overlay = document.querySelector('.onetrust-pc-dark-filter');
      // @ts-ignore
      const banner = document.querySelector('#onetrust-consent-sdk');
      if (overlay) overlay.remove();
      if (banner) banner.remove();
    });
    await page.waitForTimeout(1000);
    
    // Click login button
    log('👆 Clicking login...');
    await page.click('button[type="submit"], button[data-testid="log-in"]');
    
    // Wait for navigation
    log('⏳ Waiting for login...');
    await page.waitForTimeout(5000);
    
    // Check if logged in
    const currentUrl = page.url();
    log(`Current URL: ${currentUrl}`);
    
    // Handle MFA if required
    if (currentUrl.includes('/mfa')) {
      if (headless) {
        throw new Error('Sainsbury\'s asked for MFA — run `groc login` interactively to complete it.');
      }
      log('🔐 MFA required - SMS code sent');
      log('📱 Check your phone for the 6-digit code');
      
      // Prompt for MFA code
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      const mfaCode = await new Promise<string>((resolve) => {
        rl.question('Enter 6-digit MFA code: ', (answer: string) => {
          rl.close();
          resolve(answer.trim());
        });
      });
      
      if (!mfaCode || mfaCode.length !== 6) {
        throw new Error('Invalid MFA code - must be 6 digits');
      }
      
      log('🔑 Submitting MFA code...');
      await page.fill('#code, input[name="code"]', mfaCode);
      await page.waitForTimeout(500);
      
      // Remove cookie overlays again (they may reappear on MFA page)
      // @ts-ignore - runs in browser context
      await page.evaluate(() => {
        // @ts-ignore
        const overlay = document.querySelector('.onetrust-pc-dark-filter');
        // @ts-ignore
        const banner = document.querySelector('#onetrust-consent-sdk');
        if (overlay) overlay.remove();
        if (banner) banner.remove();
      });
      await page.waitForTimeout(500);
      
      await page.click('button[data-testid="submit-code"], button[type="submit"]:has-text("Continue")');
      
      log('⏳ Waiting for redirect...');
      await page.waitForTimeout(5000);
      
      const finalUrl = page.url();
      log(`Final URL after MFA: ${finalUrl}`);
      
      if (finalUrl.includes('login') || finalUrl.includes('mfa')) {
        throw new Error('MFA verification failed - check code and try again');
      }
    } else if (currentUrl.includes('login')) {
      throw new Error('Login failed - still on login page');
    }
    
    log('✅ Login successful!');
    
    // Get cookies
    const cookies = await context.cookies();
    
    const sessionData: SessionData = {
      cookies: cookies,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
      lastLogin: new Date().toISOString()
    };
    
    // Save session
    saveSession(sessionData);
    
    await browser.close();
    
    return sessionData;
    
  } catch (error) {
    await browser.close();
    throw error;
  }
}

export function saveSession(session: SessionData) {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
  console.error(`💾 Session saved to ${SESSION_FILE}`);
}

export function loadSession(): SessionData | null {
  if (!fs.existsSync(SESSION_FILE)) {
    return null;
  }

  try {
    const data = fs.readFileSync(SESSION_FILE, 'utf8');
    const session: SessionData = JSON.parse(data);

    // Check if expired
    if (new Date(session.expiresAt) < new Date()) {
      console.error('⚠️  Session expired');
      return null;
    }

    return session;
  } catch (error) {
    console.error('⚠️  Corrupt session file, removing');
    fs.unlinkSync(SESSION_FILE);
    return null;
  }
}

export function getCookieString(session: SessionData): string {
  return session.cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

export function clearSession() {
  if (fs.existsSync(SESSION_FILE)) {
    fs.unlinkSync(SESSION_FILE);
    console.error('🗑️  Session cleared');
  }
}
