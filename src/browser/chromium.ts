import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

// Register stealth exactly once — playwright-extra warns on duplicate plugins,
// and both k-ruoka and s-etukortti sessions need the same instance.
chromium.use(StealthPlugin());

export { chromium };
