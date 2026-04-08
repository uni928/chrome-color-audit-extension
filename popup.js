const captureBtn = document.getElementById('captureBtn');
const statusEl = document.getElementById('status');
const modeEl = document.getElementById('mode');

const DEBUGGER_VERSION = '1.3';
const TARGET_WIDTH = 1920;
const VIEWPORT_HEIGHT = 1080;
const MAX_OCCURRENCES_PER_LABEL = 2;
const DETAIL_LINE_SHORT = 28;
const DETAIL_LINE_LONG = 54;
const DETAIL_BOX_GAP = 18;
const DETAIL_PLACEMENT_TRIES = 140;

captureBtn.addEventListener('click', async () => {
  captureBtn.disabled = true;
  setStatus('ページ全体撮影の準備中です…');

  const mode = modeEl.value || 'numbered';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    setStatus('失敗しました:\nアクティブなタブが見つかりませんでした。');
    captureBtn.disabled = false;
    return;
  }

  const debuggee = { tabId: tab.id };
  let attached = false;

  try {
    await chrome.debugger.attach(debuggee, DEBUGGER_VERSION);
    attached = true;

    await chrome.debugger.sendCommand(debuggee, 'Page.enable');
    await chrome.debugger.sendCommand(debuggee, 'Runtime.enable');
    await chrome.debugger.sendCommand(debuggee, 'Emulation.setDeviceMetricsOverride', {
      width: TARGET_WIDTH,
      height: VIEWPORT_HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
      scale: 1
    });

    await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
      expression: 'window.scrollTo(0, 0)',
      awaitPromise: false
    });

    await wait(250);

    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectFullPageColorData
    });

    const colorData = injectionResults?.[0]?.result;
    if (!colorData || !Array.isArray(colorData.items)) {
      throw new Error('色情報の取得に失敗しました。');
    }

    const metrics = await chrome.debugger.sendCommand(debuggee, 'Page.getLayoutMetrics');
    const contentWidth = Math.max(1, Math.ceil(metrics.contentSize?.width || TARGET_WIDTH));
    const contentHeight = Math.max(1, Math.ceil(metrics.contentSize?.height || VIEWPORT_HEIGHT));

    setStatus(`撮影中です…\n幅: ${contentWidth}px\n高さ: ${contentHeight}px\n検出件数: ${colorData.items.length}\nモード: ${mode === 'numbered' ? '番号 + 下部凡例' : '詳しくその場所に表示'}`);

    const screenshot = await chrome.debugger.sendCommand(debuggee, 'Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width: contentWidth,
        height: contentHeight,
        scale: 1
      }
    });

    const dataUrl = `data:image/png;base64,${screenshot.data}`;
    const { blobs, pageCount } = await renderImages(dataUrl, colorData, mode);
    const baseFilename = buildBaseFilename(tab.title, mode);

    for (let i = 0; i < blobs.length; i++) {
      const blobUrl = URL.createObjectURL(blobs[i]);
      const filename = pageCount === 1
        ? `${baseFilename}.png`
        : `${baseFilename}-${String(i + 1).padStart(2, '0')}.png`;

      await chrome.downloads.download({
        url: blobUrl,
        filename,
        saveAs: i === 0
      });

      setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
    }

    setStatus(`保存を開始しました。\n出力枚数: ${pageCount}枚`);
  } catch (error) {
    console.error(error);
    setStatus(`失敗しました:\n${error.message}`);
  } finally {
    try {
      if (attached) await chrome.debugger.sendCommand(debuggee, 'Emulation.clearDeviceMetricsOverride');
    } catch (_) {}

    try {
      if (attached) await chrome.debugger.detach(debuggee);
    } catch (_) {}

    captureBtn.disabled = false;
  }
});

function setStatus(message) {
  statusEl.textContent = message;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildBaseFilename(title = 'page', mode = 'numbered') {
  const safe = String(title || 'page')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'page';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `color-audit-${mode}-${safe}-${stamp}`;
}

async function renderImages(dataUrl, colorData, mode) {
  const image = await loadImage(dataUrl);
  const scaleX = image.width / colorData.page.width;
  const scaleY = image.height / colorData.page.height;

  let prepared = prepareItems(colorData.items, scaleX, scaleY, image.width, image.height);
  assignNumbersByLabel(prepared);
  prepared = selectRepresentativeOccurrences(prepared, MAX_OCCURRENCES_PER_LABEL);

  const pages = paginateItems(prepared, mode);
  const blobs = [];

  for (let i = 0; i < pages.length; i++) {
    const blob = mode === 'detailed'
      ? await renderDetailedPage(image, pages[i], i + 1, pages.length)
      : await renderNumberedPage(image, pages[i], i + 1, pages.length);
    blobs.push(blob);
  }

  return { blobs, pageCount: pages.length };
}

function prepareItems(items, scaleX, scaleY, canvasWidth, canvasHeight) {
  const prepared = [];
  const virtualPlaced = [];
  const placedDetailBoxes = [];
  const margin = 12;
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');

  for (const item of items) {
    const rect = {
      left: item.rect.left * scaleX,
      top: item.rect.top * scaleY,
      width: item.rect.width * scaleX,
      height: item.rect.height * scaleY
    };
    rect.right = rect.left + rect.width;
    rect.bottom = rect.top + rect.height;
    rect.cx = rect.left + rect.width / 2;
    rect.cy = rect.top + rect.height / 2;

    const markerRadius = 16;
    const marker = chooseBestMarkerPlacement({
      rect,
      radius: markerRadius,
      canvasWidth,
      canvasHeight,
      placedMarkers: virtualPlaced,
      margin
    });

    virtualPlaced.push({
      x: marker.cx - markerRadius,
      y: marker.cy - markerRadius,
      w: markerRadius * 2,
      h: markerRadius * 2
    });

    measureCtx.font = '600 15px system-ui, sans-serif';
    const lines = item.label.split('\n');
    const lineHeight = 22;
    const textWidth = Math.max(...lines.map(line => measureCtx.measureText(line).width), 80);
    const boxWidth = Math.ceil(textWidth + 22);
    const boxHeight = Math.ceil(lines.length * lineHeight + 18);

    const detailPlacement = chooseBestDetailPlacement({
      rect,
      marker,
      boxWidth,
      boxHeight,
      canvasWidth,
      canvasHeight,
      margin,
      placedBoxes: placedDetailBoxes
    });

    const detailBox = {
      x: detailPlacement.x,
      y: detailPlacement.y,
      w: boxWidth,
      h: boxHeight
    };

    placedDetailBoxes.push(detailBox);

    prepared.push({
      label: item.label,
      rect,
      marker,
      markerRadius,
      detailLines: lines,
      detailBox,
      detailAnchor: detailPlacement.anchor,
      detailLineLength: detailPlacement.lineLength,
      number: null,
      visible: true
    });
  }

  return prepared;
}

function assignNumbersByLabel(items) {
  const map = new Map();
  let counter = 1;

  for (const item of items) {
    if (!map.has(item.label)) {
      map.set(item.label, counter++);
    }
    item.number = map.get(item.label);
  }
}

function selectRepresentativeOccurrences(items, limitPerLabel) {
  const grouped = new Map();

  for (const item of items) {
    const key = item.label;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }

  const result = [];

  for (const group of grouped.values()) {
    if (group.length <= limitPerLabel) {
      result.push(...group);
      continue;
    }

    const selected = farthestSample(group, limitPerLabel);
    result.push(...selected);
  }

  return result;
}

function farthestSample(items, count) {
  if (items.length <= count) return items.slice();

  const centers = items.map(item => ({ x: item.rect.cx, y: item.rect.cy }));
  const selectedIndexes = [];

  let seed = 0;
  let bestScore = -1;
  for (let i = 0; i < centers.length; i++) {
    const score = centers[i].x + centers[i].y;
    if (score > bestScore) {
      bestScore = score;
      seed = i;
    }
  }
  selectedIndexes.push(seed);

  while (selectedIndexes.length < count) {
    let bestIndex = -1;
    let bestDistance = -1;

    for (let i = 0; i < items.length; i++) {
      if (selectedIndexes.includes(i)) continue;

      let nearest = Infinity;
      for (const selectedIndex of selectedIndexes) {
        const d = distance2(centers[i], centers[selectedIndex]);
        if (d < nearest) nearest = d;
      }

      if (nearest > bestDistance) {
        bestDistance = nearest;
        bestIndex = i;
      }
    }

    if (bestIndex === -1) break;
    selectedIndexes.push(bestIndex);
  }

  return selectedIndexes.map(i => items[i]);
}

function distance2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function paginateItems(items, mode) {
  if (!items.length) return [[]];

  const HARD_MAX_ITEMS = mode === 'detailed' ? 16 : 36;
  const pages = [];
  let current = [];

  for (const item of items.sort((a, b) => {
    if (Math.abs(a.rect.top - b.rect.top) > 18) return a.rect.top - b.rect.top;
    return a.rect.left - b.rect.left;
  })) {
    current.push(item);
    if (current.length >= HARD_MAX_ITEMS) {
      pages.push(current);
      current = [];
    }
  }

  if (current.length) pages.push(current);
  return pages;
}

function chooseBestMarkerPlacement({ rect, radius, canvasWidth, canvasHeight, placedMarkers, margin }) {
  const gap = 18;
  const candidates = [
    { cx: rect.left, cy: rect.top - gap },
    { cx: rect.cx, cy: rect.top - gap },
    { cx: rect.right, cy: rect.top - gap },
    { cx: rect.right + gap, cy: rect.top },
    { cx: rect.right + gap, cy: rect.cy },
    { cx: rect.right + gap, cy: rect.bottom },
    { cx: rect.left - gap, cy: rect.top },
    { cx: rect.left - gap, cy: rect.cy },
    { cx: rect.left - gap, cy: rect.bottom },
    { cx: rect.left, cy: rect.bottom + gap },
    { cx: rect.cx, cy: rect.bottom + gap },
    { cx: rect.right, cy: rect.bottom + gap }
  ];

  let best = null;
  for (const candidate of candidates) {
    const cx = clamp(candidate.cx, margin + radius, canvasWidth - margin - radius);
    const cy = clamp(candidate.cy, margin + radius, canvasHeight - margin - radius);
    const markerBox = { x: cx - radius, y: cy - radius, w: radius * 2, h: radius * 2 };
    const overlapArea = totalOverlapArea(markerBox, placedMarkers);
    const dx = cx - rect.cx;
    const dy = cy - rect.cy;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const score = overlapArea * 1000 + distance;
    if (!best || score < best.score) best = { cx, cy, score };
  }

  return best || {
    cx: clamp(rect.cx, margin + radius, canvasWidth - margin - radius),
    cy: clamp(rect.top - gap, margin + radius, canvasHeight - margin - radius)
  };
}

function chooseBestDetailPlacement({
  rect,
  marker,
  boxWidth,
  boxHeight,
  canvasWidth,
  canvasHeight,
  margin,
  placedBoxes = []
}) {
  const cx = rect.cx;
  const cy = rect.cy;

  const dirs = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
    { dx: 1, dy: 1 },
    { dx: -1, dy: 1 },
    { dx: 1, dy: -1 },
    { dx: -1, dy: -1 }
  ];

  let best = null;

  for (const dir of dirs) {
    for (let i = 0; i < DETAIL_PLACEMENT_TRIES; i++) {
      const useLong = i >= 40;
      const baseLine = useLong ? DETAIL_LINE_LONG : DETAIL_LINE_SHORT;
      const spread = (i % 14) * 10;
      const drift = Math.floor(i / 14) * 8;

      const anchorX = marker.cx + dir.dx * (baseLine + spread);
      const anchorY = marker.cy + dir.dy * (baseLine + spread);

      let x = anchorX;
      let y = anchorY;

      if (dir.dx > 0) x += DETAIL_BOX_GAP;
      if (dir.dx < 0) x -= boxWidth + DETAIL_BOX_GAP;
      if (dir.dy > 0) y += DETAIL_BOX_GAP;
      if (dir.dy < 0) y -= boxHeight + DETAIL_BOX_GAP;

      if (dir.dx === 0) x -= boxWidth / 2;
      if (dir.dy === 0) y -= boxHeight / 2;

      if (dir.dx === 0) x += ((i % 2 === 0 ? 1 : -1) * drift);
      if (dir.dy === 0) y += ((i % 2 === 0 ? 1 : -1) * drift);

      x = clamp(x, margin, canvasWidth - boxWidth - margin);
      y = clamp(y, margin, canvasHeight - boxHeight - margin);

      const box = { x, y, w: boxWidth, h: boxHeight };

      const overlapPlaced = totalOverlapArea(box, placedBoxes);
      const overlapRect = rectOverlapArea(box, {
        x: rect.left,
        y: rect.top,
        w: rect.width,
        h: rect.height
      });

      const lineEnd = nearestPointOnBox(anchorX, anchorY, box);
      const lineDx = lineEnd.x - marker.cx;
      const lineDy = lineEnd.y - marker.cy;
      const lineLen = Math.sqrt(lineDx * lineDx + lineDy * lineDy);

      const score =
        overlapPlaced * 5000 +
        overlapRect * 4000 +
        lineLen +
        (useLong ? 20 : 0);

      if (!best || score < best.score) {
        best = {
          x,
          y,
          anchor: lineEnd,
          lineLength: lineLen,
          score
        };
      }

      if (overlapPlaced === 0 && overlapRect === 0 && !useLong) {
        return {
          x,
          y,
          anchor: lineEnd,
          lineLength: lineLen
        };
      }
    }
  }

  if (best) {
    return {
      x: best.x,
      y: best.y,
      anchor: best.anchor,
      lineLength: best.lineLength
    };
  }

  const fallbackX = clamp(rect.right + DETAIL_BOX_GAP, margin, canvasWidth - boxWidth - margin);
  const fallbackY = clamp(rect.top, margin, canvasHeight - boxHeight - margin);
  return {
    x: fallbackX,
    y: fallbackY,
    anchor: nearestPointOnBox(marker.cx, marker.cy, {
      x: fallbackX,
      y: fallbackY,
      w: boxWidth,
      h: boxHeight
    }),
    lineLength: DETAIL_LINE_LONG
  };
}

function rectOverlapArea(a, b) {
  const xOverlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const yOverlap = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return xOverlap * yOverlap;
}

function nearestPointOnBox(px, py, box) {
  const left = box.x;
  const right = box.x + box.w;
  const top = box.y;
  const bottom = box.y + box.h;

  const cx = clamp(px, left, right);
  const cy = clamp(py, top, bottom);

  const distances = [
    { x: cx, y: top, d: Math.abs(py - top) },
    { x: right, y: cy, d: Math.abs(px - right) },
    { x: cx, y: bottom, d: Math.abs(py - bottom) },
    { x: left, y: cy, d: Math.abs(px - left) }
  ];

  distances.sort((a, b) => a.d - b.d);
  return { x: distances[0].x, y: distances[0].y };
}

async function renderNumberedPage(image, pageItems, pageIndex, pageCount) {
  const legendLayout = measureLegendLayout(image.width, pageItems);
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height + legendLayout.totalHeight;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0);

  pageItems.forEach(item => drawNumberMarker(ctx, item));
  drawLegend(ctx, image.width, image.height, pageItems, legendLayout, pageIndex, pageCount);

  return await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

async function renderDetailedPage(image, pageItems, pageIndex, pageCount) {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0);

  pageItems.forEach(item => drawDetailedAnnotation(ctx, item));
  drawModeBadge(ctx, pageIndex, pageCount, 'Detailed Mode');

  return await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

function drawModeBadge(ctx, pageIndex, pageCount, text) {
  const label = pageCount > 1 ? `${text} (${pageIndex}/${pageCount})` : text;
  ctx.save();
  ctx.font = '700 18px system-ui, sans-serif';
  const w = ctx.measureText(label).width + 26;
  const h = 34;
  roundRect(ctx, 20, 20, w, h, 10);
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#111';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 33, 37);
  ctx.restore();
}

function drawNumberMarker(ctx, item) {
  const { marker, markerRadius, number } = item;
  ctx.save();

  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.beginPath();
  ctx.moveTo(marker.cx, marker.cy);
  ctx.lineTo(shortLineEndX(item), shortLineEndY(item));
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(marker.cx, marker.cy, markerRadius, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(0,0,0,0.86)';
  ctx.stroke();

  let fontSize = 18;
  if (number >= 100) fontSize = 13;
  else if (number >= 10) fontSize = 15;

  ctx.font = `700 ${fontSize}px system-ui, sans-serif`;
  ctx.fillStyle = '#111';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(number), marker.cx, marker.cy + 1);

  ctx.restore();
}

function drawDetailedAnnotation(ctx, item) {
  const { marker, markerRadius, detailLines, detailBox, detailAnchor } = item;
  ctx.save();

  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(0,0,0,0.62)';
  ctx.beginPath();
  ctx.moveTo(marker.cx, marker.cy);
  ctx.lineTo(detailAnchor.x, detailAnchor.y);
  ctx.stroke();

  ctx.beginPath();
  //ctx.arc(marker.cx, marker.cy, markerRadius, 0, Math.PI * 2);
  //ctx.fillStyle = 'rgba(255,255,255,0.97)';
  //ctx.fill();
  //ctx.lineWidth = 2;
  //ctx.strokeStyle = 'rgba(0,0,0,0.86)';
  //ctx.stroke();

  roundRect(ctx, detailBox.x, detailBox.y, detailBox.w, detailBox.h, 10);
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(0,0,0,0.82)';
  ctx.stroke();

  ctx.font = '600 15px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#111';

  for (let i = 0; i < detailLines.length; i++) {
    ctx.fillText(detailLines[i], detailBox.x + 10, detailBox.y + 10 + i * 22);
  }

  ctx.restore();
}

function shortLineEndX(item) {
  const dx = item.rect.cx - item.marker.cx;
  const dy = item.rect.cy - item.marker.cy;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const short = 20;
  return item.marker.cx + dx / len * short;
}

function shortLineEndY(item) {
  const dx = item.rect.cx - item.marker.cx;
  const dy = item.rect.cy - item.marker.cy;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const short = 20;
  return item.marker.cy + dy / len * short;
}

function measureLegendLayout(width, pageItems) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const padding = 28;
  const innerWidth = width - padding * 2;
  const colGap = 24;
  const colWidth = Math.floor((innerWidth - colGap) / 2);
  const lineHeight = 22;
  const itemGap = 14;
  const titleHeight = 42;
  const footerGap = 20;

  ctx.font = '600 15px system-ui, sans-serif';

  const legendEntries = buildLegendEntries(pageItems);
  const columns = [[], []];
  const heights = [0, 0];

  legendEntries.forEach(entry => {
    const wrapped = wrapLines(ctx, `${entry.number}  ${entry.label.replace(/\n/g, '   ')}`, colWidth);
    const blockHeight = wrapped.length * lineHeight + itemGap;
    const target = heights[0] <= heights[1] ? 0 : 1;
    columns[target].push({ lines: wrapped, height: blockHeight });
    heights[target] += blockHeight;
  });

  const contentHeight = Math.max(heights[0], heights[1]);
  return {
    padding,
    colGap,
    colWidth,
    lineHeight,
    itemGap,
    titleHeight,
    totalHeight: titleHeight + contentHeight + footerGap + 20,
    columns
  };
}

function buildLegendEntries(pageItems) {
  const seen = new Set();
  const entries = [];

  [...pageItems]
    .sort((a, b) => a.number - b.number)
    .forEach(item => {
      if (seen.has(item.number)) return;
      seen.add(item.number);
      entries.push({ number: item.number, label: item.label });
    });

  return entries;
}

function drawLegend(ctx, width, imageHeight, pageItems, layout, pageIndex, pageCount) {
  const y0 = imageHeight;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, y0, width, layout.totalHeight);

  ctx.strokeStyle = '#D9D9D9';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, y0 + 1);
  ctx.lineTo(width, y0 + 1);
  ctx.stroke();

  ctx.fillStyle = '#111';
  ctx.font = '700 20px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`Color Audit Legend ${pageCount > 1 ? `(${pageIndex}/${pageCount})` : ''}`, layout.padding, y0 + 16);

  const baseY = y0 + layout.titleHeight;
  const colXs = [layout.padding, layout.padding + layout.colWidth + layout.colGap];

  layout.columns.forEach((column, colIndex) => {
    let y = baseY;
    column.forEach(entry => {
      ctx.font = '600 15px system-ui, sans-serif';
      ctx.fillStyle = '#111';
      entry.lines.forEach((line, i) => {
        ctx.fillText(line, colXs[colIndex], y + i * layout.lineHeight);
      });
      y += entry.height;
    });
  });
}

function wrapLines(ctx, text, maxWidth) {
  const chars = Array.from(text);
  const lines = [];
  let current = '';

  for (const ch of chars) {
    const next = current + ch;
    if (ctx.measureText(next).width > maxWidth && current) {
      lines.push(current);
      current = ch;
    } else {
      current = next;
    }
  }

  if (current) lines.push(current);
  return lines;
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function totalOverlapArea(box, placedBoxes) {
  return placedBoxes.reduce((sum, other) => {
    const xOverlap = Math.max(0, Math.min(box.x + box.w, other.x + other.w) - Math.max(box.x, other.x));
    const yOverlap = Math.max(0, Math.min(box.y + box.h, other.y + other.h) - Math.max(box.y, other.y));
    return sum + xOverlap * yOverlap;
  }, 0);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pointInRect(x, y, rect) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像の読み込みに失敗しました。'));
    img.src = src;
  });
}

function collectFullPageColorData() {
  function dedupe(arr) {
    return [...new Set(arr)];
  }

  function normalizeCssColor(input) {
    if (!input || input === 'transparent' || input === 'rgba(0, 0, 0, 0)') return '';

    const value = String(input).trim();
    if (value.startsWith('#')) {
      return value.length === 4
        ? '#' + value.slice(1).split('').map(ch => ch + ch).join('').toUpperCase()
        : value.toUpperCase();
    }

    const match = value.match(/rgba?\(([^)]+)\)/i);
    if (!match) return '';

    const parts = match[1].split(',').map(part => part.trim());
    const rgb = parts.slice(0, 3).map(Number);
    const alpha = parts[3] !== undefined ? Number(parts[3]) : 1;

    if (alpha === 0 || rgb.some(Number.isNaN)) return '';
    return '#' + rgb.map(n => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  function normalizeBorderOrOutline(colorValue, widthValue) {
    if (parseFloat(widthValue || '0') <= 0) return '';
    return normalizeCssColor(colorValue);
  }

  function extractColorsFromBackgroundImage(backgroundImage) {
    if (!backgroundImage || backgroundImage === 'none') return [];
    const matches = backgroundImage.match(/#(?:[0-9a-fA-F]{3,8})|rgba?\([^)]+\)/g) || [];
    return dedupe(matches.map(normalizeCssColor).filter(Boolean));
  }

  function extractShadowColors(shadowValue) {
    if (!shadowValue || shadowValue === 'none') return [];
    const matches = shadowValue.match(/#(?:[0-9a-fA-F]{3,8})|rgba?\([^)]+\)/g) || [];
    return dedupe(matches.map(normalizeCssColor).filter(Boolean));
  }

  function measureTextActivity(el) {
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return {
      hasText: text.length > 0,
      textLength: text.length
    };
  }

  function isRenderableElement(el, style) {
    if (!style) return false;
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (parseFloat(style.opacity || '1') < 0.03) return false;

    const tag = (el.tagName || '').toLowerCase();
    if (['script', 'style', 'meta', 'link', 'noscript', 'head', 'title'].includes(tag)) return false;

    const textInfo = measureTextActivity(el);
    if (textInfo.hasText) return true;
    if (el instanceof SVGElement) return true;

    const bg = normalizeCssColor(style.backgroundColor);
    const border = normalizeBorderOrOutline(style.borderTopColor, style.borderTopWidth) ||
                   normalizeBorderOrOutline(style.borderRightColor, style.borderRightWidth) ||
                   normalizeBorderOrOutline(style.borderBottomColor, style.borderBottomWidth) ||
                   normalizeBorderOrOutline(style.borderLeftColor, style.borderLeftWidth);
    const shadow = extractShadowColors(style.boxShadow).length > 0;

    return !!(bg || border || shadow);
  }

  function getAbsoluteRect(el) {
    const rect = el.getBoundingClientRect();
    return {
      left: rect.left + window.scrollX,
      top: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height
    };
  }

  function isUsableRect(rect, pageWidth, pageHeight, hasText) {
    if (!rect) return false;
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (rect.left + rect.width <= 0 || rect.top + rect.height <= 0) return false;
    if (rect.top >= pageHeight || rect.left >= pageWidth) return false;
    if (hasText) return rect.width >= 4 && rect.height >= 4;
    return rect.width >= 8 && rect.height >= 8;
  }

  function getBackgroundLabel(style) {
    const gradientColors = extractColorsFromBackgroundImage(style.backgroundImage);
    if (gradientColors.length >= 2) return gradientColors.join(' ↘ ');
    return normalizeCssColor(style.backgroundColor);
  }

  function getBorderLabel(style) {
    const colors = [];
    [
      normalizeBorderOrOutline(style.borderTopColor, style.borderTopWidth),
      normalizeBorderOrOutline(style.borderRightColor, style.borderRightWidth),
      normalizeBorderOrOutline(style.borderBottomColor, style.borderBottomWidth),
      normalizeBorderOrOutline(style.borderLeftColor, style.borderLeftWidth),
      normalizeBorderOrOutline(style.outlineColor, style.outlineWidth),
      ...extractShadowColors(style.boxShadow)
    ].forEach(c => { if (c) colors.push(c); });
    return dedupe(colors).join(' / ');
  }

  function getTextLabel(style, element) {
    const colors = [];
    const mainText = normalizeCssColor(style.color);
    if (mainText) colors.push(mainText);

    if (element instanceof SVGElement) {
      const fill = normalizeCssColor(style.fill);
      const stroke = normalizeCssColor(style.stroke);
      if (fill) colors.push(fill);
      if (stroke) colors.push(stroke);
    }

    return dedupe(colors).join(' / ');
  }

  function buildLabel(el, style) {
    const parts = [];
    const textLabel = getTextLabel(style, el);
    const bgLabel = getBackgroundLabel(style);
    const borderLabel = getBorderLabel(style);

    if (textLabel) parts.push(`Text: ${textLabel}`);
    if (bgLabel) parts.push(`Background: ${bgLabel}`);
    if (borderLabel) parts.push(`Border: ${borderLabel}`);

    return parts.join('\n');
  }

  function buildLocationKey(rect) {
    const l = Math.round(rect.left / 6) * 6;
    const t = Math.round(rect.top / 6) * 6;
    const w = Math.round(rect.width / 6) * 6;
    const h = Math.round(rect.height / 6) * 6;
    return `${l}|${t}|${w}|${h}`;
  }

  function scoreElement(el, style, rect, textInfo, label) {
    const area = rect.width * rect.height;
    let score = area;
    if (textInfo.hasText) score += 3000 + Math.min(2000, textInfo.textLength * 8);
    if (style.position === 'fixed' || style.position === 'sticky') score += 800;
    if (el instanceof HTMLAnchorElement) score += 500;
    if (el instanceof HTMLButtonElement) score += 500;
    if (label.includes('Background:')) score += 300;
    if (label.includes('Border:')) score += 200;
    return score;
  }

  const pageWidth = Math.max(
    document.documentElement.scrollWidth,
    document.body ? document.body.scrollWidth : 0,
    window.innerWidth
  );
  const pageHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body ? document.body.scrollHeight : 0,
    window.innerHeight
  );

  const allElements = [
    document.documentElement,
    document.body,
    ...Array.from(document.querySelectorAll('*'))
  ].filter(Boolean);

  const bestByLocation = new Map();

  for (const el of allElements) {
    if (!(el instanceof Element)) continue;

    const style = getComputedStyle(el);
    if (!isRenderableElement(el, style)) continue;

    const textInfo = measureTextActivity(el);
    const rect = getAbsoluteRect(el);
    if (!isUsableRect(rect, pageWidth, pageHeight, textInfo.hasText)) continue;

    const label = buildLabel(el, style);
    if (!label) continue;

    const key = buildLocationKey(rect);
    const score = scoreElement(el, style, rect, textInfo, label);
    const existing = bestByLocation.get(key);

    if (!existing || score > existing.score) {
      bestByLocation.set(key, {
        score,
        label,
        rect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height
        }
      });
    }
  }

  const items = Array.from(bestByLocation.values())
    .map(item => ({ label: item.label, rect: item.rect }))
    .sort((a, b) => {
      if (Math.abs(a.rect.top - b.rect.top) > 18) return a.rect.top - b.rect.top;
      return a.rect.left - b.rect.left;
    });

  return {
    page: {
      width: pageWidth,
      height: pageHeight
    },
    items
  };
}
