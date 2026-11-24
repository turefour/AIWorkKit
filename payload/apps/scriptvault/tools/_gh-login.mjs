/**
 * 临时脚本：接管已登录的 Edge，用页面内的 fetch 完成 GitHub device 授权。
 * curl/node 直连 github.com 不稳定，但浏览器能通 —— 所以把请求放进页面里发。
 */
import { connect } from '../lib/cdp.mjs';

const PORT = 9223;
const CLIENT = '178c6fc778ccc68e1d6a';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cdp = await connect(PORT);
await cdp.send('Page.enable');

/** 在页面上下文里 await 一个 Promise 并取回结果。 */
async function evalAsync(expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 30000
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.text || 'eval failed');
  }
  return res.result ? res.result.value : undefined;
}

// 保证在 GitHub 页面上下文里（跨域 fetch 需要同源）
await cdp.send('Page.navigate', { url: 'https://github.com/' });
await sleep(5000);
console.log('页面: ' + (await cdp.evaluate('location.href')));

// 1. 页面内请求 device code
const dc = await evalAsync(`
  fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: new URLSearchParams({ client_id: '${CLIENT}', scope: 'repo' })
  }).then(r => r.json())
`);
if (!dc || !dc.user_code) {
  console.log('生成 code 失败: ' + JSON.stringify(dc));
  cdp.close();
  process.exit(1);
}
console.log('验证码: ' + dc.user_code);

// 2. 打开授权页并自动填入
await cdp.send('Page.navigate', { url: 'https://github.com/login/device' });
await sleep(5000);

const filled = await cdp.evaluate(`(function(){
  const input = document.querySelector('input[name="user_code"], #user-code, input[autocomplete="one-time-code"]');
  if (!input) return 'no-input:' + location.href;
  input.focus();
  input.value = ${JSON.stringify(dc.user_code)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  const form = input.closest('form');
  if (!form) return 'no-form';
  const btn = form.querySelector('button[type="submit"]');
  if (btn) { btn.click(); return 'clicked-submit'; }
  form.submit();
  return 'form-submitted';
})()`);
console.log('提交验证码: ' + filled);
await sleep(6000);

console.log('提交后 URL: ' + (await cdp.evaluate('location.href')));
console.log('提交后文本: ' + (await cdp.evaluate('document.body.innerText.slice(0,200)')).replace(/\n/g, ' | '));

// 3. 如果出现 Authorize 确认按钮，点它
const authClicked = await cdp.evaluate(`(function(){
  const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
  const target = btns.find(b => /authorize/i.test(b.textContent || b.value || ''));
  if (target) { target.click(); return 'authorized:' + (target.textContent || target.value).trim(); }
  return 'no-authorize-button';
})()`);
console.log('授权按钮: ' + authClicked);
await sleep(5000);

// 4. 页面内轮询换 token
for (let i = 1; i <= 12; i += 1) {
  const t = await evalAsync(`
    fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: '${CLIENT}',
        device_code: ${JSON.stringify(dc.device_code)},
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      })
    }).then(r => r.json())
  `);
  if (t && t.access_token) {
    console.log('TOKEN_OK');
    console.log('TOKEN=' + t.access_token);
    cdp.close();
    process.exit(0);
  }
  console.log(`[${i}] ${t && t.error}`);
  if (t && t.error && t.error !== 'authorization_pending' && t.error !== 'slow_down') break;
  await sleep(4000);
}

console.log('未拿到 token');
cdp.close();
process.exit(1);
