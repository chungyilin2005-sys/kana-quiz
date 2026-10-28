// 書寫模式：KanjiVG 筆順資料解析、筆順動畫、螢幕手寫的田字格 canvas。
// parseKanjiVG 是純函式（測試直接 import）；其餘函式才會碰 DOM。

const SVG_NS = 'http://www.w3.org/2000/svg';
const KVG_SIZE = 109;
const STROKE_SEC = 0.5;
const STROKE_GAP_SEC = 0.15;

// 手指固定 6px；觸控筆依壓力在 4～8px 之間
const FINGER_WIDTH = 6;
const PEN_MIN = 4;
const PEN_MAX = 8;

// KanjiVG 檔名：Unicode 五碼十六進位，例如 あ = 03042.svg
export function strokeFile(kana) {
  return `strokes/${kana.codePointAt(0).toString(16).padStart(5, '0')}.svg`;
}

// 只有單一字元（清音、濁音、半濁音）有筆順動畫；拗音只顯示範字
export function hasStrokeData(kana) {
  return [...kana].length === 1;
}

// 從 KanjiVG 的 SVG 原始碼取出每一筆的路徑與筆順數字位置（依筆順排序）
export function parseKanjiVG(svgText) {
  const strokes = [];
  for (const m of svgText.matchAll(/<path\b[^>]*\bid="kvg:[0-9a-f]+-s(\d+)"[^>]*>/g)) {
    const d = m[0].match(/\bd="([^"]+)"/);
    if (d) strokes.push({ n: Number(m[1]), d: d[1] });
  }
  strokes.sort((a, b) => a.n - b.n);

  const labels = [];
  for (const m of svgText.matchAll(/<text\b[^>]*transform="matrix\(1 0 0 1 ([\d.]+) ([\d.]+)\)"[^>]*>(\d+)<\/text>/g)) {
    labels.push({ n: Number(m[3]), x: Number(m[1]), y: Number(m[2]) });
  }
  return strokes.map((s) => {
    const label = labels.find((l) => l.n === s.n);
    return { d: s.d, label: label ? { x: label.x, y: label.y } : null };
  });
}

const cache = new Map();

export function loadStrokes(kana) {
  if (!cache.has(kana)) {
    const p = fetch(strokeFile(kana))
      .then((res) => {
        if (!res.ok) throw new Error(res.status);
        return res.text();
      })
      .then(parseKanjiVG)
      .catch((err) => {
        cache.delete(kana);
        throw err;
      });
    cache.set(kana, p);
  }
  return cache.get(kana);
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// 筆順動畫：淡色底稿上依序畫出每一筆（每筆 0.5 秒），筆畫開始時在起點標出筆順數字。
// 回傳 SVG 元素；replay() 重新播放。
export function strokeAnimation(strokes) {
  const svg = svgEl('svg', { viewBox: `0 0 ${KVG_SIZE} ${KVG_SIZE}`, class: 'stroke-anim', 'aria-hidden': 'true' });
  const ghost = svgEl('g', { class: 'stroke-ghost' });
  const ink = svgEl('g', { class: 'stroke-ink' });
  const nums = svgEl('g', { class: 'stroke-nums' });
  strokes.forEach((s, i) => {
    const delay = `${(i * (STROKE_SEC + STROKE_GAP_SEC)).toFixed(2)}s`;
    ghost.append(svgEl('path', { d: s.d }));
    ink.append(svgEl('path', { d: s.d, pathLength: '1', style: `animation-delay:${delay}` }));
    if (s.label) {
      const t = svgEl('text', { x: s.label.x, y: s.label.y, style: `animation-delay:${delay}` });
      t.textContent = String(i + 1);
      nums.append(t);
    }
  });
  svg.append(ghost, ink, nums);
  svg.replay = () => {
    // 重新插入節點讓 CSS 動畫從頭開始
    const parent = svg.parentNode;
    if (!parent) return;
    const next = svg.nextSibling;
    svg.remove();
    void svg.getBoundingClientRect();
    parent.insertBefore(svg, next);
  };
  svg.duration = strokes.length * (STROKE_SEC + STROKE_GAP_SEC);
  return svg;
}

// 螢幕手寫的田字格。筆跡存成「筆畫陣列」（座標以 0～1 的比例保存），
// 才能復原上一筆，也能在旋轉螢幕、視窗大小改變後依比例重畫。
export class WritingPad {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.strokes = [];
    this.current = null;
    this.pointerId = null;
    this.listeners = new Set();

    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
    canvas.addEventListener('lostpointercapture', (e) => this.up(e));
    // 長按不要跳出選單
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.resizeObserver = new ResizeObserver(() => {
      if (!canvas.isConnected) {
        this.resizeObserver.disconnect();
        return;
      }
      this.resize();
    });
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  // 內部像素 = 顯示尺寸 × devicePixelRatio，筆跡才不會模糊
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = window.devicePixelRatio || 1;
    this.size = rect.width;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.redraw();
  }

  point(e) {
    const rect = this.canvas.getBoundingClientRect();
    const w = e.pointerType === 'pen' && e.pressure > 0
      ? PEN_MIN + (PEN_MAX - PEN_MIN) * Math.min(1, e.pressure)
      : FINGER_WIDTH;
    return [(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height, w];
  }

  down(e) {
    // 同時只追蹤一根手指，手掌或第二根手指碰到就忽略
    if (this.pointerId != null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    this.pointerId = e.pointerId;
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* 部分瀏覽器不支援時照常畫 */ }
    this.current = [this.point(e)];
    this.strokes.push(this.current);
    this.drawSegment(this.current, 0);
  }

  move(e) {
    if (e.pointerId !== this.pointerId || !this.current) return;
    e.preventDefault();
    const events = e.getCoalescedEvents?.() || [];
    for (const ev of events.length ? events : [e]) {
      this.current.push(this.point(ev));
      this.drawSegment(this.current, this.current.length - 1);
    }
  }

  up(e) {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.current = null;
    this.emit();
  }

  drawSegment(stroke, i) {
    const ctx = this.ctx;
    const s = this.size;
    const [x, y, w] = stroke[i];
    ctx.strokeStyle = getComputedStyle(this.canvas).color;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (i === 0) {
      ctx.beginPath();
      ctx.arc(x * s, y * s, w / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    const [px, py, pw] = stroke[i - 1];
    ctx.lineWidth = (w + pw) / 2;
    ctx.beginPath();
    ctx.moveTo(px * s, py * s);
    ctx.lineTo(x * s, y * s);
    ctx.stroke();
  }

  redraw() {
    this.ctx.clearRect(0, 0, this.size, this.size);
    for (const stroke of this.strokes) {
      for (let i = 0; i < stroke.length; i++) this.drawSegment(stroke, i);
    }
  }

  undo() {
    if (this.current) return;
    this.strokes.pop();
    this.redraw();
    this.emit();
  }

  clear() {
    if (this.current) return;
    this.strokes = [];
    this.redraw();
    this.emit();
  }

  get isEmpty() {
    return this.strokes.length === 0;
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this);
  }
}
