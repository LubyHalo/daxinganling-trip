// 画册模式的附加视觉：把逐日行程串成一条"河流"——顺着滚动，河流从上游流到下游，
// 每一天是一个节点。算法移植自原有的 hulunbuir-7day-trip.html。
//
// 与速查模式的取舍：这套东西只负责好看，任何一步失败都必须安静降级，
// 绝不能因为浏览器不支持某个 SVG 能力就把整页搞挂。

let scrollBound = false;
let rafPending = false;

// 不假设 requestAnimationFrame 一定存在：没有就退回 setTimeout。
// （滚动动画是锦上添花，绝不能因为它把渲染整条链路搞挂。）
const nextFrame = (fn) => {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(fn);
  return setTimeout(fn, 16);
};

const DRAW = 'M';
let current = null; // { main, glow, dots, dayEls, rail }

/** Catmull-Rom 转三次贝塞尔，得到平滑曲线 */
function catmullRomPath(points) {
  if (!points.length) return '';
  let d = `${DRAW} ${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

function onScroll() {
  if (!current || rafPending) return;
  rafPending = true;
  nextFrame(() => {
    rafPending = false;
    if (!current) return;
    const vh = window.innerHeight || 1;

    // 水域进度：模拟画笔从左到右、从上到下把河流"画出来"
    if (current.total > 0) {
      const rect = current.svg.getBoundingClientRect();
      const p = Math.min(1, Math.max(0, (vh * 0.6 - rect.top) / Math.max(rect.height, 1)));
      current.main.style.strokeDashoffset = String(current.total * (1 - p));
      current.glow.style.strokeDashoffset = String(current.total * (1 - p));
    }

    // 当前所在的那一天
    let idx = -1;
    current.dayEls.forEach((el, i) => {
      if (el.getBoundingClientRect().top <= vh * 0.55) idx = i;
    });
    current.dots.forEach((dot, i) => dot.classList.toggle('active', i === idx));
  });
}

function layout() {
  if (!current) return;
  const { svg, glow, main, dotsWrap, dots, dayEls, container } = current;
  const w = container.clientWidth || 0;
  if (!w) return;

  const narrow = w < 880;
  const railX = (i) => (narrow ? 34 : (i % 2 === 0 ? w * 0.34 : w * 0.66));

  const containerTop = container.getBoundingClientRect().top + window.pageYOffset;
  const centers = dayEls.map((el) => {
    const r = el.getBoundingClientRect();
    return r.top + window.pageYOffset - containerTop + r.height / 2;
  });
  const h = container.offsetHeight || 0;
  const pts = [[w / 2, -40], ...centers.map((y, i) => [railX(i), y]), [w / 2, h + 40]];

  const d = catmullRomPath(pts);
  main.setAttribute('d', d);
  glow.setAttribute('d', d);
  svg.setAttribute('viewBox', `0 -60 ${w} ${h + 120}`);
  svg.style.height = `${h + 120}px`;

  // 被"画出来"的效果依赖 getTotalLength；不支持时安静降级为一条完整的静态曲线
  const canDash = typeof main.getTotalLength === 'function';
  if (canDash) {
    const total = main.getTotalLength() || 0;
    current.total = total;
    main.style.strokeDasharray = String(total);
    glow.style.strokeDasharray = String(total);
  } else {
    current.total = 0;
  }

  dotsWrap.innerHTML = '';
  dots.length = 0;
  centers.forEach((y, i) => {
    const dot = document.createElement('span');
    dot.className = 'river-dot';
    dot.style.left = `${railX(i)}px`;
    dot.style.top = `${y}px`;
    dotsWrap.appendChild(dot);
    dots.push(dot);
  });
  onScroll();
}

/** 在当前视图里挂上河流。返回是否成功挂上。 */
export function mountRiver(viewEl) {
  if (!viewEl) return false;
  const section = viewEl.querySelector('.river');
  if (!section) return false;
  const dayEls = [...section.querySelectorAll('.day')];
  if (!dayEls.length) return false;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'river-svg');
  svg.setAttribute('aria-hidden', 'true');
  const glow = document.createElementNS(NS, 'path');
  glow.setAttribute('class', 'river-path-glow');
  const main = document.createElementNS(NS, 'path');
  main.setAttribute('class', 'river-path');
  svg.appendChild(glow);
  svg.appendChild(main);

  const dotsWrap = document.createElement('div');
  dotsWrap.className = 'river-dots';

  section.insertBefore(dotsWrap, section.firstChild);
  section.insertBefore(svg, section.firstChild);

  current = { container: section, svg, glow, main, dotsWrap, dots: [], dayEls, total: 0 };
  layout();

  if (!scrollBound) {
    scrollBound = true;
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', () => {
      clearTimeout(mountRiver._t);
      mountRiver._t = setTimeout(layout, 150);
    });
  }
  return true;
}

export function unmountRiver() {
  current = null;
}
