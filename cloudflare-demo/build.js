/**
 * 📦 Tanz Probe - Cloudflare Worker 一键打包生成器
 * 运行方式: node build.js
 * 自动读取 ../public/index.html 与 ../public/app.js 并打包成单文件 worker.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const htmlPath = path.resolve(__dirname, '../public/index.html');
const jsPath = path.resolve(__dirname, '../public/app.js');
const workerTemplatePath = path.resolve(__dirname, 'worker.template.js');
const workerOutPath = path.resolve(__dirname, 'worker.js');

if (!fs.existsSync(htmlPath) || !fs.existsSync(jsPath)) {
  console.error('❌ 未找到 public/index.html 或 public/app.js');
  process.exit(1);
}

let htmlContent = fs.readFileSync(htmlPath, 'utf8');
const jsContent = fs.readFileSync(jsPath, 'utf8');

// 针对演示站调整标题
htmlContent = htmlContent.replace('Tanz Probe', 'Tanz Probe · 在线体验演示');

// 使用最高压缩率 Gzip
const htmlGz = zlib.gzipSync(Buffer.from(htmlContent, 'utf8'), { level: 9 });
const jsGz = zlib.gzipSync(Buffer.from(jsContent, 'utf8'), { level: 9 });

const htmlB64 = htmlGz.toString('base64');
const jsB64 = jsGz.toString('base64');

console.log(`📊 静态文件压缩完成:`);
console.log(`   HTML: ${(Buffer.byteLength(htmlContent) / 1024).toFixed(1)} KB -> Gzip ${(htmlGz.length / 1024).toFixed(1)} KB (Base64: ${(htmlB64.length / 1024).toFixed(1)} KB)`);
console.log(`   JS:   ${(Buffer.byteLength(jsContent) / 1024).toFixed(1)} KB -> Gzip ${(jsGz.length / 1024).toFixed(1)} KB (Base64: ${(jsB64.length / 1024).toFixed(1)} KB)`);

let currentWorker = fs.readFileSync(workerOutPath, 'utf8');
currentWorker = currentWorker.replace(/const HTML_GZIP_B64 = ".*?";/, `const HTML_GZIP_B64 = "${htmlB64}";`);
currentWorker = currentWorker.replace(/const JS_GZIP_B64 = ".*?";/, `const JS_GZIP_B64 = "${jsB64}";`);

fs.writeFileSync(workerOutPath, currentWorker, 'utf8');
console.log(`🎉 成功更新 worker.js！总大小: ${(fs.statSync(workerOutPath).size / 1024).toFixed(1)} KB`);
