import { chromium, Browser, Page } from 'playwright';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { execSync } from 'child_process';

export class PlaywrightService {
  private browser: Browser | null = null;
  private page: Page | null = null;

  async initialize() {
    if (this.browser) {
      return;
    }

    try {
      logger.log('Initializing Playwright browser');
      this.browser = await chromium.launch({
        headless: false
      });

      this.page = await this.browser.newPage();
      await this.page.setViewportSize(config.browser.viewport);
    } catch (error) {
      if (error instanceof Error && error.message.includes("Executable doesn't exist")) {
        logger.log('Chromium not found, attempting to install...');
        try {
          execSync('npx playwright install chromium', { stdio: 'inherit' });
          // Retry browser launch after installation
          this.browser = await chromium.launch({
            headless: false
          });
          this.page = await this.browser.newPage();
          await this.page.setViewportSize(config.browser.viewport);
        } catch (installError) {
          logger.error('Failed to install Chromium:', installError);
          throw new Error('Failed to initialize browser. Please run: npx playwright install chromium');
        }
      } else {
        throw error;
      }
    }
  }

  async getPage(): Promise<Page | null> {
    return this.page;
  }

  async cleanup() {
    if (this.page) {
      await this.page.close().catch(e => logger.error('Error closing page:', e));
      this.page = null;
    }
    if (this.browser) {
      await this.browser.close().catch(e => logger.error('Error closing browser:', e));
      this.browser = null;
    }
  }

  async goto(url: string) {
    if (!this.page) throw new Error('Browser not initialized');
    
    logger.log('Navigating to:', url);
    try {
      await this.page.goto(url, {
        waitUntil: 'networkidle',
        timeout: config.browser.timeouts.navigation
      });
    } catch (error) {
      logger.error('Navigation failed, retrying with domcontentloaded:', error);
      // Retry with less strict wait condition
      await this.page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: config.browser.timeouts.navigation
      });
      // Wait a bit for any additional content to load
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  async clickBySelector(selector: string) {
    if (!this.page) throw new Error('Browser not initialized');

    logger.log('Clicking element by selector:', selector);
    try {
      // Wait longer for dynamic content
      const element = await this.page.waitForSelector(selector, { 
        state: 'visible', 
        timeout: 10000  // Increased timeout
      });
      
      if (!element) {
        throw new Error('Element not found after waiting');
      }

      // Check if element is actually visible and clickable
      const isVisible = await element.isVisible();
      if (!isVisible) {
        throw new Error('Element is not visible');
      }

      // Get element position
      const box = await element.boundingBox();
      if (!box) {
        throw new Error('Element has no bounding box');
      }

      // Wait for element to be stable (no movement)
      await this.page.waitForTimeout(500);

      // Try direct click first
      try {
        await element.click({
          timeout: 10000,  // Increased timeout
          force: false,
          delay: 100  // Add slight delay
        });
      } catch (error) {
        logger.log('Direct click failed, trying alternative methods...');
        
        // Wait a bit before trying alternative
        await this.page.waitForTimeout(500);
        
        // Try clicking with JavaScript
        await this.page.evaluate((sel: string) => {
          const element = document.querySelector(sel);
          if (element) {
            // Dispatch mousedown and mouseup events before click
            element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            (element as HTMLElement).click();
          }
        }, selector);
        
        // Wait longer to see if the click had an effect
        await this.page.waitForTimeout(2000);
      }
      
      logger.log('Successfully clicked element');
    } catch (error) {
      logger.error('Click by selector failed:', error);
      throw new Error(`Failed to click element with selector: ${selector}`);
    }
  }

  async typeBySelector(selector: string, text: string) {
    if (!this.page) throw new Error('Browser not initialized');

    logger.log('Typing text by selector:', { selector, text });
    try {
      const element = await this.page.waitForSelector(selector, { 
        state: 'visible', 
        timeout: 10000  // Increased timeout
      });
      
      if (!element) {
        throw new Error('Element not found after waiting');
      }

      // Check if element is actually visible and editable
      const isVisible = await element.isVisible();
      const isEditable = await element.isEditable();
      
      if (!isVisible) {
        throw new Error('Element is not visible');
      }
      
      if (!isEditable) {
        throw new Error('Element is not editable');
      }

      // Try focusing the element first
      await element.focus();
      await this.page.waitForTimeout(200);  // Increased wait after focus

      // Try direct type first
      try {
        await element.fill('');  // Clear existing text
        await element.type(text, { delay: 100 });  // Increased typing delay
        
        // Wait for potential autocomplete/dropdown to appear
        await this.page.waitForTimeout(1000);
        
        // Press Enter to trigger search
        await element.press('Enter');
        
        // Wait for results to load
        await this.page.waitForTimeout(2000);
      } catch (error) {
        logger.log('Direct type failed, trying alternative methods...');
        
        // Try typing with JavaScript
        const script = `(sel, val) => {
          const element = document.querySelector(sel);
          if (element) {
            element.value = val;
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
            element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
          }
        }`;
        await this.page.evaluate(script, selector, text);

        // Wait for results to load
        await this.page.waitForTimeout(2000);
      }
      
      logger.log('Successfully typed text');
    } catch (error) {
      logger.error('Type by selector failed:', error);
      throw new Error(`Failed to type text into element with selector: ${selector}`);
    }
  }

  async getCurrentUrl(): Promise<string> {
    if (!this.page) throw new Error('Browser not initialized');
    return this.page.url();
  }

  async takeScreenshot(): Promise<string> {
    if (!this.page) throw new Error('Browser not initialized');

    logger.log('Taking screenshot');
    try {
      const screenshot = await this.page.screenshot({
        type: 'jpeg',
        quality: 80,
        fullPage: true
      });

      return screenshot.toString('base64');
    } catch (error) {
      logger.error('Screenshot failed:', error);
      throw new Error('Failed to take screenshot');
    }
  }

  async waitForLoadState() {
    if (!this.page) throw new Error('Browser not initialized');

    try {
      await this.page.waitForLoadState('networkidle', {
        timeout: config.browser.timeouts.networkIdle
      });
    } catch (error) {
      logger.log('Network idle timeout reached, continuing anyway');
    }

    // Additional wait for any dynamic content
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  async evaluateAccessibility() {
    if (!this.page) throw new Error('Browser not initialized');

    try {
      // Get all clickable elements with their properties
      const elements = await this.page.evaluate(() => {
        const clickable = document.querySelectorAll('a, button, [role="button"], input[type="submit"]');
        return Array.from(clickable).map(el => ({
          tag: el.tagName,
          text: el.textContent?.trim(),
          isVisible: !!(el.getBoundingClientRect().width && el.getBoundingClientRect().height),
          href: el instanceof HTMLAnchorElement ? el.href : null,
          role: el.getAttribute('role'),
        }));
      });

      return elements;
    } catch (error) {
      logger.error('Accessibility evaluation failed:', error);
      return [];
    }
  }
}

// Export singleton instance
export const playwrightService = new PlaywrightService(); 