const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const https = require('https');
const fs = require('fs');

// Use stealth plugin
puppeteer.use(StealthPlugin());

/**
 * Crawls product data from Shopee Affiliate page
 * @param {string} productId - The product ID to crawl
 * @returns {Promise<object>} The extracted product data
 */
async function crawlProduct(productId) {
  // Path to store browser session data
  const userDataDir = path.join(__dirname, 'shopee_user_data');

  console.log(`--- Launching Browser for Product ID: ${productId} ---`);

  // Launch Chrome
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: false,
      userDataDir: userDataDir,
      defaultViewport: { width: 1280, height: 720 },
      args: [
        '--window-position=0,0',
        '--disable-blink-features=AutomationControlled'
      ]
    });
  } catch (err) {
    if (err.message.includes('The browser is already running')) {
      console.error('!!! ERROR: Browser profile is locked. Attempting to force cleanup... !!!');
      const { execSync } = require('child_process');
      try {
        execSync('pkill -f firefox || true');
        execSync('pkill -f chromium || true');
        execSync('pkill -f "Google Chrome" || true');

        const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort'];
        lockFiles.forEach(file => {
          const filePath = path.join(userDataDir, file);
          if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch (e) { }
          }
        });

        await new Promise(r => setTimeout(r, 2000));
        browser = await puppeteer.launch({
          headless: false,
          userDataDir: userDataDir,
          defaultViewport: { width: 1280, height: 720 },
          args: [
            '--window-position=0,0',
            '--disable-blink-features=AutomationControlled'
          ]
        });
      } catch (retryErr) {
        throw new Error(`Failed to launch browser after cleanup: ${retryErr.message}`);
      }
    } else {
      throw err;
    }
  }

  const [page] = await browser.pages();

  // --- Cookie Injection Logic ---
  const cookiesPath = path.join(__dirname, 'cookies.json');
  if (fs.existsSync(cookiesPath)) {
    try {
      const cookiesString = fs.readFileSync(cookiesPath, 'utf8');
      const cookiesData = JSON.parse(cookiesString);

      // Handle different cookie formats (Array vs J2TEAM object)
      let cookies = Array.isArray(cookiesData) ? cookiesData : (cookiesData.cookies || []);

      if (cookies.length > 0) {
        console.log(`🍪 Parsing ${cookies.length} cookies from file...`);

        const validCookies = cookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          expires: c.expirationDate,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite === 'unspecified' ? undefined : c.sameSite
        })).filter(c => c.name !== 'TEMPLATE_COOKIE_NAME');

        if (validCookies.length > 0) {
          await page.setCookie(...validCookies);
          console.log(`✅ Successfully injected ${validCookies.length} cookies!`);
        } else {
          console.log('⚠️ No valid cookies found after filtering.');
        }
      } else {
        console.log('⚠️ cookies.json found but contains no cookies.');
      }
    } catch (err) {
      console.error('❌ Failed to load cookies.json:', err.message);
    }
  }

  // Using is_from_login=true as requested
  const url = `https://affiliate.shopee.vn/offer/product_offer/${productId}?is_from_login=true`;

  // --- Human Interaction Helpers ---
  async function humanDelay(min = 2000, max = 5000) {
    const delay = Math.floor(Math.random() * (max - min)) + min;
    await new Promise(r => setTimeout(r, delay));
  }

  // --- Helper: HTTP Request (Node.js Native) ---
  function makeRequest(url, method, body = null) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: method,
        headers: {
          'Content-Type': 'application/json'
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(data);
          }
        });
      });

      req.on('error', (e) => reject(e));
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // --- Slider Captcha Solver (Anti-Captcha API) ---
  async function solveSliderCaptcha(page) {
    try {
      console.log('🧩 Detected Slider Captcha! Preparing to solve...');

      // 1. Get API Key
      const keyPath = path.join(__dirname, 'anticaptcha_key.txt');
      let apiKey = '';
      if (fs.existsSync(keyPath)) {
        apiKey = fs.readFileSync(keyPath, 'utf8').trim();
      }

      if (!apiKey || apiKey.includes('PASTE_YOUR')) {
        console.log('⚠️ API Key missing in anticaptcha_key.txt. Skipping solver.');
        return;
      }

      // 2. Wait for captcha to fully render
      await humanDelay(1000, 2000);

      // 3. Extract actual captcha images from DOM
      console.log('📸 Extracting captcha images from DOM...');

      const imageData = await page.evaluate(() => {
        const container = document.querySelector('.sec-container');
        if (!container) return null;

        const imgs = container.querySelectorAll('img');
        const result = { piece: null, bg: null, debug: [] };

        // Log all images found
        imgs.forEach((img, i) => {
          result.debug.push({
            index: i,
            src: img.src ? img.src.substring(0, 100) : 'none',
            width: img.naturalWidth || img.width,
            height: img.naturalHeight || img.height,
            className: img.className
          });
        });

        // Assign images: first = piece, second = background (adjust if needed)
        if (imgs.length >= 2) {
          result.piece = imgs[0].src;
          result.bg = imgs[1].src;
        } else if (imgs.length === 1) {
          result.bg = imgs[0].src;
        }

        // Also check CSS background-image
        const allElements = container.querySelectorAll('*');
        allElements.forEach(el => {
          const bgImg = window.getComputedStyle(el).backgroundImage;
          if (bgImg && bgImg !== 'none' && bgImg.includes('url(')) {
            const url = bgImg.replace(/url\(['"]?/, '').replace(/['"]?\)/, '');
            result.debug.push({ type: 'css-bg', url: url.substring(0, 100), className: el.className });
            if (!result.bg) result.bg = url;
            else if (!result.piece) result.piece = url;
          }
        });

        // Log container HTML for debugging
        result.html = container.innerHTML.substring(0, 1500);

        return result;
      });

      console.log('🔍 Debug - Images found:', JSON.stringify(imageData?.debug, null, 2));
      if (imageData?.html) {
        console.log('🔍 Debug - Container HTML:', imageData.html.substring(0, 500));
      }

      if (!imageData || (!imageData.piece && !imageData.bg)) {
        console.log('❌ Could not find captcha images in DOM');
        return;
      }

      // 4. Convert image URLs to base64
      async function imgUrlToBase64(imgSrc) {
        if (!imgSrc) return null;

        // Already base64 data URL
        if (imgSrc.startsWith('data:image')) {
          return imgSrc.split(',')[1];
        }

        // Download from URL
        return new Promise((resolve, reject) => {
          const protocol = imgSrc.startsWith('https') ? https : require('http');
          protocol.get(imgSrc, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
            res.on('error', reject);
          }).on('error', reject);
        });
      }

      const pieceBase64 = await imgUrlToBase64(imageData.piece);
      const bgBase64 = await imgUrlToBase64(imageData.bg);

      console.log(`📐 Piece: ${pieceBase64 ? pieceBase64.length + ' chars' : 'NULL'}`);
      console.log(`📐 Background: ${bgBase64 ? bgBase64.length + ' chars' : 'NULL'}`);

      // Save images for debugging
      if (pieceBase64) fs.writeFileSync(path.join(__dirname, 'captcha_piece.png'), Buffer.from(pieceBase64, 'base64'));
      if (bgBase64) fs.writeFileSync(path.join(__dirname, 'captcha_bg.png'), Buffer.from(bgBase64, 'base64'));
      console.log('💾 Saved captcha_piece.png and captcha_bg.png for inspection');

      if (!pieceBase64 || !bgBase64) {
        console.log('❌ Missing one or both captcha images');
        return;
      }

      // 5. Send to Anti-Captcha API (dạng mới kéo cong)
      console.log('🚀 Sending to Anti-Captcha API...');
      const apiUrl = 'https://anticaptcha.top/in.php';

      const payload = {
        key: apiKey,
        method: 'base64',
        click: 'shopee',
        textinstructions: 'rotate',
        body: pieceBase64 + '|' + bgBase64,
        json: 1
      };

      const response = await makeRequest(apiUrl, 'POST', payload);
      console.log('📩 API Response:', response);

      if (!response.request) {
        console.log('❌ API Error:', response);
        return;
      }

      const taskId = response.request;
      console.log(`🆔 Task ID: ${taskId}. Waiting for result...`);

      // 6. Poll for Result
      let result = null;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));

        const resUrl = `https://anticaptcha.top/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`;
        const resData = await makeRequest(resUrl, 'GET');

        if (typeof resData === 'object' && resData.status === 1) {
          result = resData.request;
          console.log('\n✅ Solution received:', result);
          break;
        } else if (typeof resData === 'object' && resData.request === 'CAPCHA_NOT_READY') {
          process.stdout.write('.');
        } else {
          console.log('\n⚠️ Unexpected response:', resData);
        }
      }

      if (!result) {
        console.log('\n❌ Failed to get solution in time.');
        return;
      }

      // 7. Parse solution & drag slider
      const solutionX = parseInt(result);
      if (isNaN(solutionX)) {
        console.log('❌ Invalid solution X:', result);
        return;
      }

      // Find slider handle for dragging
      const sliderHandle = await page.$('.sec-container .slider-container .slider-key');
      const sliderContainer = await page.$('.sec-container .slider-container');

      if (!sliderHandle || !sliderContainer) {
        console.log('⚠️ Could not find slider handle for dragging.');
        return;
      }

      const handleBox = await sliderHandle.boundingBox();
      if (!handleBox) return;

      const startX = handleBox.x + handleBox.width / 2;
      const startY = handleBox.y + handleBox.height / 2;
      const targetX = startX + solutionX;

      console.log(`🖱️  Dragging to X=${targetX.toFixed(0)} (Distance: ${solutionX})...`);

      await page.mouse.move(startX, startY);
      await page.mouse.down();

      // Human-like drag with easing + jitter
      const steps = 40;
      for (let i = 0; i < steps; i++) {
        const progress = i / steps;
        const ease = 1 - (1 - progress) * (1 - progress);
        const nextX = startX + (targetX - startX) * ease;
        const jitterY = (Math.random() - 0.5) * 4;

        await page.mouse.move(nextX, startY + jitterY);
        await new Promise(r => setTimeout(r, Math.random() * 10 + 5));
      }

      // Final precise move
      await page.mouse.move(targetX, startY);
      await new Promise(r => setTimeout(r, 100));

      await page.mouse.up();
      console.log('✅ Slider released!');
      await humanDelay(3000, 4000);

    } catch (e) {
      console.log('❌ Error solving slider:', e.message);
    }
  }

  // --- Navigate ---
  console.log(`--- Navigating to: ${url} ---`);
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  } catch (e) {
    console.log('--- Navigation took too long or failed ---');
  }

  // --- Verification & Captcha Detection Logic ---
  async function checkVerificationState() {
    return await page.evaluate(() => {
      const url = window.location.href;
      const text = document.body.innerText;
      return url.includes('/verify/') ||
        url.includes('shopee.vn/login') ||
        text.includes('Đăng nhập') ||
        text.includes('Xác minh');
    });
  }

  async function checkAndSolveCaptcha() {
    await humanDelay(2000, 3000);
    const hasCaptcha = await page.$('.sec-container');
    if (hasCaptcha) {
      console.log('🧩 Captcha detected on page!');
      await solveSliderCaptcha(page);
      await humanDelay(2000, 3000);
      return true;
    }
    return false;
  }

  let isBlocked = await checkVerificationState();

  if (isBlocked) {
    console.warn('!!! BLOCKED - Checking for captcha... !!!');

    // Try solving captcha up to 3 times
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`\n🔄 Captcha solve attempt ${attempt}/3...`);

      const hadCaptcha = await checkAndSolveCaptcha();

      if (!hadCaptcha) {
        console.log('⚠️ No captcha found on page. May need manual login.');
        break;
      }

      // Check if we got through
      isBlocked = await checkVerificationState();
      if (!isBlocked) {
        console.log('🎉 Captcha solved! Access granted!');
        break;
      }

      console.log(`❌ Still blocked after attempt ${attempt}.`);
    }

    // If still blocked, wait for manual intervention
    if (isBlocked) {
      console.warn('!!! MANUAL WARM-UP REQUIRED - Please login/verify manually !!!');
      try {
        await page.waitForFunction((pid) => {
          const currentUrl = window.location.href;
          return currentUrl.includes(`product_offer/${pid}`) &&
            !currentUrl.includes('/verify/') &&
            !currentUrl.includes('/login');
        }, { timeout: 300000 }, productId);

        console.log('--- ACCESS GRANTED ---');
      } catch (e) {
        console.log('--- Manual verification timed out after 5 minutes ---');
      }
    }

    await humanDelay(3000, 5000);
  }

  // --- Click Button & Extract Link Phase ---
  let productData = { error: 'Failed to extract data' };
  try {
    console.log('--- Waiting for .get-link-btn ---');

    await page.waitForSelector('.get-link-btn', { timeout: 15000 });
    console.log('✅ Found .get-link-btn');

    await humanDelay(1000, 1500);

    await page.evaluate(() => {
      const btn = document.querySelector('.get-link-btn');
      if (btn) btn.click();
    });
    console.log('🖱️  Clicked .get-link-btn (via JS)');

    try {
      await page.waitForSelector('.ant-modal-content', { timeout: 10000 });
      console.log('✅ Modal appeared');

      await page.waitForFunction(() => {
        const modal = document.querySelector('.ant-modal-content');
        return modal && (modal.querySelector('input') || modal.querySelector('textarea'));
      }, { timeout: 5000 });
      console.log('✅ Input field appeared inside modal');

      console.log('⏳ Waiting 3s for modal content to fully render...');
      await humanDelay(3000, 3500);

    } catch (e) {
      console.log('⚠️ Warning: Modal or Input did not appear within timeout', e.message);
    }

    const affiliateLink = await page.evaluate(() => {
      const modal = document.querySelector('.ant-modal-content');
      if (!modal) return null;

      console.log('Searching in modal:', modal.innerHTML);

      const input = modal.querySelector('input.ant-input') ||
        modal.querySelector('input[type="text"]') ||
        modal.querySelector('textarea') ||
        modal.querySelector('input');

      return input ? input.value : null;
    });

    if (affiliateLink) {
      console.log(`\n🎉 EXTRACTED AFFILIATE LINK:\n${affiliateLink}\n`);

      productData = {
        affiliateLink: affiliateLink,
        url: page.url(),
        status: 'success',
        timestamp: new Date().toISOString()
      };
    } else {
      console.log('❌ Modal opened but input not found/empty');

      const modalHTML = await page.evaluate(() => {
        const m = document.querySelector('.ant-modal-content');
        return m ? m.innerHTML : 'NULL';
      });
      console.log('DEBUG MODAL HTML (structure):', modalHTML.substring(0, 500) + '...');

      productData = {
        error: 'Modal opened but could not find link input',
        status: 'error'
      };
    }

  } catch (err) {
    console.log('--- Error during extraction: ', err.message);
    productData = { error: err.message, status: 'error' };
  }

  // Close browser after extraction
  console.log('⏳ Browser will remain open for inspection...');
  // await page.close();
  // await browser.close();

  return productData;
}

module.exports = { crawlProduct };
