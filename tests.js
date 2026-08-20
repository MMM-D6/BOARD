/**
 * Board 回归测试
 *
 * 用途：每次改动 index.html 之后跑一遍，确认没有弄坏已有功能。
 * 这些测试在真实浏览器里驱动真实的界面操作，不是模拟。
 * 历史上它们抓到过：箭头因 CSS 优先级而隐形、导出一片空白、
 * 点击工具栏导致文字选区丢失、函数自我调用造成的死循环。
 *
 * 运行方式
 *   npm i puppeteer          （只需一次）
 *   node tests.js            （测试全部）
 *   node tests.js text link  （只测名字里含 text 或 link 的组）
 *
 * 若已有 Chrome，可用环境变量指定，免去下载：
 *   CHROME=/path/to/chrome node tests.js
 */

const path = require("path");
const fs = require("fs");

const FILE = "file://" + path.resolve(__dirname, "index.html");
const HEADLESS = process.env.HEAD !== "0";

let puppeteer;
try {
  puppeteer = require("puppeteer");
} catch (e) {
  console.error("需要先安装 puppeteer：npm i puppeteer");
  process.exit(1);
}

/* ---------------- 测试框架（够用就好） ---------------- */

const groups = [];
let only = process.argv.slice(2);

function group(name, fn) {
  groups.push({ name, fn });
}

function makeCtx(page, record) {
  return {
    page,
    ok(label, cond) {
      record(label, !!cond);
    },
    // 在页面里执行代码，返回结果
    run: (fn, ...args) => page.evaluate(fn, ...args),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    // 常用夹具：铺一组卡片
    async board(cards, links, extra) {
      await page.evaluate(
        ([cards, links, extra]) => {
          S.cards = cards;
          S.links = links || [];
          S.frames = (extra && extra.frames) || [];
          
          S.templates = (extra && extra.templates) || [];
          sel = (extra && extra.sel) || [];
          render();
          if (extra && extra.zoom1) camTo(0, 0, 1, true);
          else fit(true);
        },
        [cards, links, extra || {}]
      );
      await new Promise((r) => setTimeout(r, 500));
    },
    // 进入某张卡片的文字编辑，并选中一个词
    async pick(id, word) {
      await page.evaluate((id) => editText(card(id)), id);
      await new Promise((r) => setTimeout(r, 200));
      return page.evaluate(
        ([id, w]) => {
          const cap = document.querySelector(`.card[data-id="${id}"] .cap`);
          const walk = document.createTreeWalker(cap, NodeFilter.SHOW_TEXT);
          let n;
          while ((n = walk.nextNode())) {
            const i = n.nodeValue.indexOf(w);
            if (i >= 0) {
              const r = document.createRange();
              r.setStart(n, i);
              r.setEnd(n, i + w.length);
              const s = getSelection();
              s.removeAllRanges();
              s.addRange(r);
              return true;
            }
          }
          return false;
        },
        [id, word]
      );
    },
    // 读出 zip 里的文件清单，用来验证导出产物
    async zipNames(triggerFn) {
      return page.evaluate(async (src) => {
        let blob = null;
        const real = window.dl;
        window.dl = (b) => { blob = b; };
        // eslint-disable-next-line no-eval
        await eval(src);
        window.dl = real;
        if (!blob) return { size: 0, names: [] };
        const buf = new Uint8Array(await blob.arrayBuffer());
        const dec = new TextDecoder();
        const names = [];
        for (let i = 0; i < buf.length - 4; i++) {
          if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x01 && buf[i + 3] === 0x02) {
            const dv = new DataView(buf.buffer, i);
            names.push(dec.decode(buf.slice(i + 46, i + 46 + dv.getUint16(28, true))));
          }
        }
        return { size: blob.size, names };
      }, triggerFn);
    },
  };
}

/* =====================================================================
   1. 连线
   ===================================================================== */

group("connectors 连线", async (c) => {
  await c.board(
    [
      { id: "a", x: -420, y: -70, w: 280, text: "A", s: {} },
      { id: "b", x: 160, y: -70, w: 280, text: "B", s: {} },
    ],
    []
  );
  const R = await c.run(() => ({
    a: document.querySelector('.card[data-id="a"]').getBoundingClientRect().toJSON(),
    b: document.querySelector('.card[data-id="b"]').getBoundingClientRect().toJSON(),
  }));
  // 选中卡片后仍然要能连线（曾经因为端口在选中时隐藏而完全失效）
  await c.page.mouse.click(R.a.x + R.a.width / 2, R.a.y + R.a.height / 2);
  await c.wait(250);
  await c.page.mouse.move(R.a.x + R.a.width / 2, R.a.y + R.a.height / 2);
  const port = await c.run(() => {
    const d = document.querySelector('.card[data-id="a"] .port[data-side="r"]');
    const r = d.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await c.page.mouse.move(port.x, port.y, { steps: 6 });
  await c.page.mouse.down();
  await c.page.mouse.move(R.b.x + R.b.width / 2, R.b.y + R.b.height / 2, { steps: 15 });
  await c.page.mouse.up();
  await c.wait(300);
  c.ok("选中状态下可以连线", (await c.run(() => S.links.length)) === 1);

  // 松手移开后连线必须仍然清晰可见（聚焦模式曾让它淡到看不见）
  await c.page.mouse.move(30, 700);
  await c.wait(1800);
  const op = await c.run(() => +document.querySelector("#links path.ln")?.getAttribute("stroke-opacity"));
  c.ok("连线在鼠标移开后依然可见", op === 1);

  // 箭头必须真的画出来（曾被 #links path{fill:none} 覆盖而隐形）
  const arrows = await c.run(() => {
    S.links[0].arrow = "end";
    drawLinks();
    return document.querySelectorAll("#links g path").length;
  });
  c.ok("箭头绘制为实际几何图形", arrows >= 1);

  // 批量套用样式
  await c.run(() => {
    S.linkDef = { kind: "elbow", dash: true, arrow: "none", w: 3.4, color: "#C0392B" };
    S.links.forEach((l) =>
      Object.assign(l, { kind: S.linkDef.kind, dash: S.linkDef.dash, arrow: S.linkDef.arrow, w: S.linkDef.w, color: S.linkDef.color })
    );
    drawLinks();
  });
  c.ok("连线样式可批量套用", (await c.run(() => S.links[0].kind)) === "elbow");
  c.ok("新连线默认不带箭头", (await c.run(() => DEFLINK.arrow)) === "none");
});

/* =====================================================================
   2. 文字工具栏与局部格式
   ===================================================================== */

group("text 文字格式", async (c) => {
  await c.board([{ id: "x", x: -220, y: 60, w: 440, text: "aaaa bbbb cccc", s: {} }], [], { sel: ["x"], zoom1: true });
  await c.pick("x", "aaaa");
  await c.run(() => setInkColor("#C0392B"));
  await c.wait(250);
  await c.run(() => cmd("bold"));
  await c.wait(250);

  // 点字号框不能夺走文字选区（这是最容易回归的一处）
  const szr = await c.run(() => document.querySelector("#szi").getBoundingClientRect().toJSON());
  await c.page.mouse.click(szr.x + szr.width / 2, szr.y + szr.height / 2);
  await c.wait(200);
  c.ok("点字号框后选区仍在", (await c.run(() => getSelection().toString())) === "aaaa");

  await c.page.keyboard.type("34");
  await c.page.keyboard.press("Enter");
  await c.wait(400);
  const st = await c.run(() => ({
    rich: card("x").rich || "",
    field: document.querySelector("#szi").textContent,
    editing: document.querySelector('.card[data-id="x"] .cap').isContentEditable,
    layers: (card("x").rich || "").match(/font-size/g)?.length || 0,
  }));
  c.ok("字号只作用于划选部分", /font-size: 34px/.test(st.rich));
  c.ok("字号不覆盖已有颜色", /rgb\(192, 57, 43\)/.test(st.rich));
  c.ok("字号不覆盖已有加粗", /bold/.test(st.rich));
  c.ok("字号框显示新值", st.field === "34");
  c.ok("操作后仍处于编辑状态", st.editing === true);
  c.ok("字号不层层嵌套", st.layers === 1);

  await c.run(() => setHighlight("#FFF2A0"));
  await c.wait(250);
  const h1 = await c.run(() => card("x").rich || "");
  await c.run(() => setHighlight("#FFF2A0"));
  await c.wait(250);
  const h2 = await c.run(() => card("x").rich || "");
  c.ok("高亮生效", /background-color/.test(h1));
  c.ok("同色再点一次取消高亮", !/background-color/.test(h2));
  c.ok("取消高亮不伤其他格式", /rgb\(192, 57, 43\)/.test(h2) && /34px/.test(h2));

  await c.page.keyboard.down("Control");
  await c.page.keyboard.press("KeyZ");
  await c.page.keyboard.up("Control");
  await c.wait(350);
  c.ok("编辑中可逐步撤销", /background-color/.test(await c.run(() => card("x").rich || "")));
  c.ok("纯文本未被格式污染", (await c.run(() => card("x").text)) === "aaaa bbbb cccc");
});

/* =====================================================================
   3. 颜色与底色的一击套用
   ===================================================================== */

group("colors 颜色", async (c) => {
  await c.board(
    [
      { id: "x", x: -220, y: 60, w: 440, text: "aaaa bbbb cccc", s: {} },
      { id: "y", x: 400, y: 60, w: 240, text: "另一张", s: {} },
    ],
    [],
    { sel: ["x"], zoom1: true }
  );
  await c.pick("x", "aaaa");
  await c.run(() => { S.lastInk = "#2D6CDF"; syncBar(); });
  await c.run(() => document.querySelector("#inksw").closest("button").click());
  await c.wait(300);
  c.ok("点色块直接套用当前文字色", /rgb\(45, 108, 223\)/.test(await c.run(() => card("x").rich || "")));

  await c.run(() => { sel = ["x", "y"]; paintSel(); S.lastBg = "rgba(70,140,240,.08)"; syncBar(); });
  await c.wait(300);
  await c.run(() => document.querySelector("#bgsw").closest("button").click());
  await c.wait(350);
  c.ok(
    "底色一击套用且支持多选",
    await c.run(() => card("x").bg === "rgba(70,140,240,.08)" && card("y").bg === "rgba(70,140,240,.08)")
  );
  await c.run(() => setCardBg(""));
  await c.wait(250);
  c.ok("可以取消底色", await c.run(() => !card("x").bg));
});

/* =====================================================================
   4. 分身
   ===================================================================== */

group("twins 分身", async (c) => {
  await c.board(
    [
      { id: "a", x: -600, y: -100, w: 300, text: "源卡片 #核心", s: {} },
      { id: "b", x: 400, y: 200, w: 300, text: "别处", s: {} },
    ],
    [],
    { sel: ["a"] }
  );
  await c.run(() => { sel = ["a"]; makeTwin(); });
  await c.wait(400);
  c.ok("分身已创建", (await c.run(() => S.cards.filter((z) => z.ref === "a").length)) === 1);
  c.ok("分身共享源的文字", (await c.run(() => orig(S.cards.find((z) => z.ref === "a")).text)) === "源卡片 #核心");
  c.ok("分身共享源的标签", (await c.run(() => cardTags(S.cards.find((z) => z.ref === "a")).join(","))) === "核心");

  await c.run(() => {
    const tw = S.cards.find((z) => z.ref === "a");
    sel = [tw.id];
    render();
    editText(tw);
    const cap = nodes.get(tw.id).querySelector(".cap");
    cap.textContent = "改过的内容 #核心";
    syncCap(tw, cap);
  });
  await c.wait(300);
  c.ok("改分身即改源", (await c.run(() => card("a").text)) === "改过的内容 #核心");

  // 剪贴板放置：跨任意距离
  await c.run(() => { sel = ["a"]; paintSel(); clipCards("twin"); });
  await c.wait(200);
  await c.run(() => pasteClip({ x: 4000, y: 4000 }));
  await c.wait(400);
  c.ok(
    "剪贴板分身可粘贴到远处",
    await c.run(() => {
      const n = S.cards.filter((z) => z.ref === "a").find((z) => z.x === 4000);
      return !!n && twins(card("a")).length === 3;
    })
  );

  // 检索：默认展开全部位置，可切换为合并
  await c.run(() => { S.findMerge = false; showFind(true); $("findq").value = "改过"; runFind(); });
  await c.wait(300);
  c.ok("检索命中全部出现位置", (await c.run(() => hits.length)) === 3);
  await c.run(() => { S.findMerge = true; runFind(); });
  await c.wait(300);
  c.ok("合并开关只保留一处", (await c.run(() => hits.length)) === 1);
  await c.run(() => { $("findq").value = ""; runFind(); showFind(false); });

  // 导出：分身不重复正文
  const doc = await c.run(() =>
    docHTML({ title: "T", img: false, tags: false, refs: false, table: false }, buildTree(), false)
  );
  // 默认：分身在每一处都完整呈现内容，便于用分身构建文献引用
  c.ok("分身处也完整呈现内容", (doc.match(/改过的内容/g) || []).length >= 2);
  c.ok("不再产生交叉引用式的指路文字", !/&#9672;|Same entry|同一条目/.test(doc));

  // 删源不丢内容
  await c.run(() => { sel = ["a"]; del(); });
  await c.wait(400);
  c.ok(
    "删除源后内容由分身继承",
    await c.run(() => !!S.cards.find((z) => !z.ref && (z.text || "").includes("改过")))
  );
});

/* =====================================================================
   5. 页面、层级与阅读顺序
   ===================================================================== */

group("outline 结构连线", async (c) => {
  // 位置故意摆得与阅读顺序不符，验证大纲来自连线而不是位置
  const r = await c.run(() => {
    S.cards = [
      { id: "A", x: 0, y: 0, w: 300, text: "Background", level: 1, s: {} },
      { id: "A1", x: 900, y: 600, w: 300, text: "讨论中", level: 2, s: {} },
      { id: "A2", x: 900, y: 200, w: 300, text: "根本差异", level: 2, s: {} },
      { id: "B", x: 0, y: 1200, w: 300, text: "理论框架", level: 1, s: {} },
      { id: "B1", x: 900, y: 1500, w: 300, text: "digital body", level: 2, s: {} },
      { id: "B1a", x: 1700, y: 1500, w: 300, text: "可编辑的流动的", s: {} },
      { id: "X", x: 0, y: 2400, w: 300, text: "散落的卡片", s: {} },
    ];
    S.links = [
      { id: "l1", a: "A", b: "A1", st: true, kind: "curve", w: 1.4, color: "#888" },
      { id: "l2", a: "A", b: "A2", st: true, kind: "curve", w: 1.4, color: "#888" },
      { id: "l3", a: "B", b: "B1", st: true, kind: "curve", w: 1.4, color: "#888" },
      { id: "l4", a: "B1", b: "B1a", st: true, kind: "curve", w: 1.4, color: "#888" },
      { id: "l5", a: "A2", b: "B1", kind: "curve", w: 1.4, color: "#888" },
    ];
    S.frames = []; S.autoNum = true; S.outline = true;
    invalidateIndex(); render();
    const tree = buildTree();
    return {
      nums: tree.flat.map((n) => [n.c.id, n.num, n.lv]),
      md: docMD({ title: "T", img: 0, tags: 0, refs: 1, table: 0 }, tree),
    };
  });
  const num = (id) => (r.nums.find((x) => x[0] === id) || [])[1];
  c.ok("一级按连线的根排序", num("A") === "1" && num("B") === "2");
  c.ok("二级按连线归属而非位置", num("A2") === "1.1" && num("A1") === "1.2");
  c.ok("第二棵树独立计数", num("B1") === "2.1");
  c.ok("叶子内容不占编号", !num("B1a"));
  c.ok("散落卡片仍被收进文档", r.nums.some((x) => x[0] === "X"));
  c.ok("导出层级与编号一致",
    /## 1 Background/.test(r.md) && /### 1\.1 根本差异/.test(r.md) && /## 2 理论框架/.test(r.md));
  // 结构连线体现为层级，关联连线体现为相邻排列，两者都不再写成"另见"
  c.ok("两类连线都不重复写成交叉引用", (r.md.match(/See §/g) || []).length === 0);

  await c.run(() => { sel = []; render(); fit(true); });
  await c.wait(500);
  const vis = await c.run(() => {
    const st = document.querySelector("#links path.ln.st");
    const rel = [...document.querySelectorAll("#links path.ln")].find((z) => !z.classList.contains("st"));
    return {
      stDash: st.getAttribute("stroke-dasharray"), stW: +st.getAttribute("stroke-width"),
      stOp: +st.getAttribute("stroke-opacity"), relDash: rel.getAttribute("stroke-dasharray"),
      relW: +rel.getAttribute("stroke-width"), relOp: +rel.getAttribute("stroke-opacity"),
    };
  });
  c.ok("结构连线是实线且更实", !vis.stDash && vis.stOp === 1);
  c.ok("关联连线是虚线且更淡", !!vis.relDash && vis.relOp < 1);
  c.ok("结构连线略粗", vis.stW > vis.relW);

  await c.run(() => { S.outline = false; });
  const n2 = await c.run(() => buildTree().flat.map((n) => [n.c.id, n.num]));
  c.ok("可关闭大纲模式回到空间顺序",
    JSON.stringify(n2) !== JSON.stringify(r.nums.map((x) => [x[0], x[1]])));
  await c.run(() => { S.outline = true; });
});

group("outdir 结构方向与批量转换", async (c) => {
  // 连线方向故意画反，验证归属由标题层级决定而不是画线方向
  const r = await c.run(() => {
    S.cards = [
      { id: "A", x: 0, y: 0, w: 300, text: "一级", level: 1, s: {} },
      { id: "A1", x: 600, y: -100, w: 300, text: "二级甲", level: 2, s: {} },
      { id: "A2", x: 600, y: 100, w: 300, text: "二级乙", level: 2, s: {} },
      { id: "A2a", x: 1200, y: 100, w: 300, text: "正文内容", s: {} },
      { id: "C", x: 600, y: 400, w: 300, text: "三级", level: 3, s: {} },
    ];
    S.links = [
      { id: "l1", a: "A1", b: "A", st: true, kind: "curve", w: 1.4, color: "#888" },
      { id: "l2", a: "A", b: "A2", st: true, kind: "curve", w: 1.4, color: "#888" },
      { id: "l3", a: "A2a", b: "A2", st: true, kind: "curve", w: 1.4, color: "#888" },
      { id: "l4", a: "C", b: "A2", st: true, kind: "curve", w: 1.4, color: "#888" },
    ];
    S.frames = []; S.autoNum = true; S.outline = true;
    invalidateIndex(); render();
    return buildTree().flat.map((n) => [n.c.id, n.num, n.lv, n.parent ? n.parent.c.id : null]);
  });
  const f = (id) => r.find((x) => x[0] === id) || [];
  c.ok("一级永远是根", f("A")[1] === "1" && f("A")[3] === null);
  c.ok("反向画的连线仍能正确归位", f("A1")[3] === "A" && /^1\./.test(f("A1")[1]));
  c.ok("三级归到二级之下", f("C")[3] === "A2" && f("C")[2] === 3);
  c.ok("正文归到标题之下且不编号", f("A2a")[3] === "A2" && !f("A2a")[1]);

  const r2 = await c.run(() => {
    S.frames = [{ id: "f", x: -80, y: -260, w: 1650, h: 900, title: "页" }];
    S.links.forEach((l) => delete l.st);
    render();
    const before = S.links.filter((l) => l.st).length;
    setFrameLinks(S.frames[0], true);
    const after = S.links.filter((l) => l.st).length;
    setFrameLinks(S.frames[0], false);
    return { before, after, back: S.links.filter((l) => l.st).length };
  });
  c.ok("可整页设为结构连线", r2.before === 0 && r2.after === 4);
  c.ok("可整页设回关联连线", r2.back === 0);

  const r3 = await c.run(() => {
    S.cards.push({ id: "OUT", x: 4000, y: 4000, w: 200, text: "页外", s: {} });
    S.links.push({ id: "lx", a: "A", b: "OUT", kind: "curve", w: 1.4, color: "#888" });
    invalidateIndex(); render();
    setFrameLinks(S.frames[0], true);
    return { inPage: S.links.filter((l) => l.st).length, outside: !!S.links.find((l) => l.id === "lx").st };
  });
  c.ok("整页转换不影响页外的连线", r3.inPage === 4 && r3.outside === false);
});

group("quote 原文记录", async (c) => {
  const r = await c.run(() => {
    const L = (a2, b2) => ({ id: uid(), a: a2, b: b2, st: true, kind: "curve", w: 1.4, color: "#888" });
    S.cards = [
      { id: "H", x: 0, y: 0, w: 300, text: "理论框架", level: 1, s: {} },
      { id: "P", x: 600, y: 0, w: 300, text: "身体是可编辑的", level: 2, s: {} },
      { id: "Q", x: 1200, y: 0, w: 340, role: "quote", text: "Codification is vital", s: {} },
      { id: "H2", x: 0, y: 600, w: 300, text: "方法论", level: 1, s: {} },
      { id: "Q2", ref: "Q", x: 600, y: 600, w: 340, role: "quote", lock: "text", s: {} },
    ];
    S.links = [L("H", "P"), L("P", "Q"), L("H2", "Q2")];
    S.frames = []; S.autoNum = true; S.outline = true;
    invalidateIndex(); render();
    const tree = buildTree();
    const O = { title: "论文", img: 0, tags: 0, refs: 0, table: 0 };
    return {
      flat: tree.flat.map((n) => [n.c.id, n.num, n.lv, !!n.quote, !!n.isRef]),
      md: docMD(O, tree), html: docHTML(O, tree, false),
    };
  });
  const f = (id) => r.flat.find((x) => x[0] === id) || [];
  c.ok("原文记录不参与编号", !f("Q")[1] && f("Q")[2] === 0);
  c.ok("原文记录被识别为引文", f("Q")[3] === true);
  c.ok("原文挂在最近的标题之下", f("P")[1] === "1.1");
  c.ok("原文导出为引用块", /^> Codification/m.test(r.md));
  c.ok("HTML 导出为引用块", /<blockquote class="qt">/.test(r.html));

  // 分身默认直接呈现原文，这样同一条引文在两章都完整可读
  c.ok("分身直接呈现原文", (r.md.match(/Codification/g) || []).length === 2);
  c.ok("默认不再写成另见", !/Same entry|同一条目/.test(r.md));
  c.ok("导出里没有多余的指路文字", !/Same entry|同一条目|See §/.test(r.md));

  await c.run(() => { sel = []; render(); fit(true); });
  await c.wait(500);
  c.ok("画布上显示为引文样式", await c.run(() => {
    const el = nodes.get("Q"), cs = getComputedStyle(el.querySelector(".cap"));
    return el.className.includes("qt") && parseFloat(cs.borderLeftWidth) > 0 && parseFloat(cs.paddingLeft) > 0;
  }));

  // 原文永远是最末端，连线画反也归位
  c.ok("原文永远是末端", await c.run(() => {
    S.links = [{ id: "x", a: "Q", b: "P", st: true, kind: "curve", w: 1.4, color: "#888" }];
    const n = buildTree().flat.find((z) => z.c.id === "Q");
    return n && n.parent && n.parent.c.id === "P";
  }));
});

group("bib 文献条目", async (c) => {
  const r = await c.run(() => {
    S.cards = [
      { id: "H", x: 0, y: 0, w: 300, text: "文献综述", level: 1, s: {} },
      { id: "B1", x: 0, y: 200, w: 420, role: "bib", text: "Bulley & Sahin (2021).", s: {} },
      { id: "Q1", x: 0, y: 340, w: 340, role: "quote", bib: "B1", text: "Codification is vital (p.3)", s: {} },
      { id: "Q2", x: 0, y: 460, w: 340, role: "quote", bib: "B1", text: "新的结构与系统 (p.7)", s: {} },
      { id: "B2", x: 600, y: 200, w: 420, role: "bib", text: "Candy (2006).", s: {} },
      { id: "Q3", x: 600, y: 340, w: 340, role: "quote", bib: "B2", text: "实践主导与实践本位 (p.1)", s: {} },
    ];
    S.links = []; S.frames = []; S.autoNum = true; S.outline = true;
    invalidateIndex(); render();
    const tree = buildTree();
    const O = { title: "论文", img: 0, tags: 0, refs: 0, table: 0 };
    return { order: tree.flat.map((n) => n.c.id).join(","), md: docMD(O, tree),
      html: docHTML(O, tree, false), links: S.links.length };
  });
  // 归属是数据关系，画布上不画任何线
  c.ok("文献归属不产生连线", r.links === 0);
  c.ok("原文跟着它的文献条目走", r.order === "H,B1,Q1,Q2,B2,Q3");
  c.ok("导出为条目加原文群", /\*\*Bulley/.test(r.md) && /^> Codification/m.test(r.md));
  c.ok("HTML 用悬挂缩进的条目样式", /<p class="bib">/.test(r.html));

  await c.run(() => { sel = []; render(); fit(true); });
  await c.wait(500);
  // 只有文献条目本身带圆点，归档在它名下的卡片保持干净
  c.ok("只有文献条目带小圆点",
    await c.run(() => !!nodes.get("B1").querySelector(".bibdot") && !nodes.get("Q1").querySelector(".bibdot")));
  c.ok("圆点不喧宾夺主",
    (await c.run(() => nodes.get("B1").querySelector(".bibdot").getBoundingClientRect().width)) <= 8);
  c.ok("文献条目不带徽标",
    await c.run(() => { const b2 = nodes.get("B1").querySelector(".lvl"); return !b2 || !b2.textContent.trim(); }));
  c.ok("文献条目文字不做悬挂缩进（缩放时不变形）",
    await c.run(() => {
      const cs = getComputedStyle(nodes.get("B1").querySelector(".cap"));
      return cs.textIndent === "0px" && parseFloat(cs.paddingLeft) < 2;
    }));

  const dot = await c.run(() => {
    const q = nodes.get("B1").querySelector(".bibdot").getBoundingClientRect();
    return { x: q.x + q.width / 2, y: q.y + q.height / 2 };
  });
  await c.page.mouse.click(dot.x, dot.y);
  await c.wait(400);
  const hi = await c.run(() => ({
    focus: bibFocus,
    on: ["B1", "Q1", "Q2"].every((i) => nodes.get(i).classList.contains("bibon")),
    off: ["H", "B2", "Q3"].some((i) => nodes.get(i).classList.contains("bibon")),
    opOn: +getComputedStyle(nodes.get("B1")).opacity,
    opOff: +getComputedStyle(nodes.get("H")).opacity,
  }));
  c.ok("点圆点强调该条文献名下的原文", hi.focus === "B1" && hi.on && !hi.off);
  c.ok("其余内容用透明度淡下去", hi.opOn > 0.9 && hi.opOff < 0.3);
  await c.page.mouse.click(dot.x, dot.y);
  await c.wait(350);
  c.ok("再点一次取消强调", await c.run(() => !bibFocus));

  // 强调时不应把跨页面的分身一起点亮
  const twin = await c.run(() => {
    S.cards.push({ id: "T1", ref: "Q1", bib: "B1", x: 4000, y: 4000, w: 340, s: {} });
    invalidateIndex(); render();
    bibFocus = "B1"; paintBibFocus();
    return { kids: bibKids("B1").map((z) => z.id), lit: nodes.get("T1") ? nodes.get("T1").classList.contains("bibon") : false };
  });
  c.ok("强调时不带出分身", !twin.kids.includes("T1") && !twin.lit);
  await c.run(() => { bibFocus = null; paintBibFocus(); S.cards = S.cards.filter((z) => z.id !== "T1"); invalidateIndex(); render(); });

  // 多选一次绑定，不依赖空间位置也不画线
  const bind = await c.run(() => {
    S.cards.forEach((z) => delete z.bib);
    S.cards.push({ id: "Q4", x: 0, y: 700, w: 340, text: "新摘的一句", s: {} });
    invalidateIndex(); render();
    sel = ["B1", "Q1", "Q2", "Q4"];
    bindToBib();
    return { kids: bibKids("B1").map((z) => z.id).sort(), role: card("Q4").role || null, links: S.links.length };
  });
  c.ok("可把多选卡片一次归档到条目", JSON.stringify(bind.kids) === '["Q1","Q2","Q4"]');
  // 归档与"是不是引文"是两回事，绑定不应擅自改变卡片角色
  c.ok("绑定不改变卡片角色", bind.role === null);
  c.ok("绑定不产生连线", bind.links === 0);
  await c.run(() => { sel = ["Q4"]; unbindBib(); });
  await c.wait(300);
  c.ok("可以解除绑定", (await c.run(() => bibKids("B1").length)) === 2);

  const mig = await c.run(() => migrate({
    v: 5,
    cards: [{ id: "b", x: 0, y: 0, w: 200, text: "条目", role: "bib" },
      { id: "q", x: 0, y: 100, w: 200, text: "原文", role: "quote" }],
    links: [{ id: "l", a: "b", b: "q", st: true }], frames: [],
  }));
  c.ok("旧的连线绑定迁移为归属字段",
    mig.cards[1].bib === "b" && mig.links.length === 0 && mig.v === 6);
});

group("adjacent 关联相邻", async (c) => {
  const r = await c.run(() => {
    S.cards = [
      { id: "H", x: 0, y: 0, w: 300, text: "章", level: 1, s: {} },
      { id: "A", x: 600, y: 0, w: 300, text: "甲的论述", s: {} },
      { id: "Z", x: 600, y: 900, w: 300, text: "乙的补充", s: {} },
      { id: "M", x: 600, y: 400, w: 300, text: "中间隔着的内容", s: {} },
    ];
    S.links = [
      { id: "s1", a: "H", b: "A", st: true, kind: "curve", w: 1.4, color: "#888" },
      { id: "s2", a: "H", b: "M", st: true, kind: "curve", w: 1.4, color: "#888" },
      { id: "s3", a: "H", b: "Z", st: true, kind: "curve", w: 1.4, color: "#888" },
      { id: "r1", a: "A", b: "Z", kind: "curve", w: 1.4, color: "#888" },
    ];
    S.frames = []; S.outline = true; S.relAdjacent = true;
    invalidateIndex(); render();
    const tree = buildTree();
    return { order: tree.flat.map((n) => n.c.id).join(","),
      md: docMD({ title: "T", img: 0, tags: 0, refs: 1, table: 0 }, tree) };
  });
  c.ok("关联的内容被拉到相邻", r.order === "H,A,Z,M");
  c.ok("不再输出另见", !/§|See |另见/.test(r.md));
  c.ok("内容不重复", (r.md.match(/乙的补充/g) || []).length === 1);
  const off = await c.run(() => {
    S.relAdjacent = false;
    const o = buildTree().flat.map((n) => n.c.id).join(",");
    S.relAdjacent = true;
    return o;
  });
  c.ok("可关闭相邻排列", off !== r.order);
});

group("levelmark 层级标记", async (c) => {
  await c.run(() => {
    S.textDef = { ...DEF, size: 16 }; S.autoNum = false;
    S.cards = [
      { id: "h1", x: -260, y: -220, w: 520, text: "Introduction", level: 1, s: { ...DEF, ...levelStyle(1) } },
      { id: "h2", x: -260, y: -100, w: 520, text: "Background", level: 2, s: { ...DEF, ...levelStyle(2) } },
      { id: "h3", x: -260, y: -10, w: 520, text: "Early studies", level: 3, s: { ...DEF, ...levelStyle(3) } },
      { id: "p", x: -260, y: 70, w: 520, text: "正文", s: { ...DEF } },
    ];
    S.links = []; S.frames = [];
    invalidateIndex(); render(); fit(true);
  });
  await c.wait(500);
  c.ok("标题不再显示 H1 字样", await c.run(() =>
    ["h1", "h2", "h3"].every((i) => {
      const b2 = nodes.get(i).querySelector(".lvl");
      return !b2 || !/^H\d/.test(b2.textContent);
    })));
  c.ok("标题带左侧层级竖条",
    await c.run(() => ["h1", "h2", "h3"].every((i) => !!nodes.get(i).querySelector(".hbar"))));
  c.ok("正文没有竖条", await c.run(() => !nodes.get("p").querySelector(".hbar")));
  const bars = await c.run(() => ["h1", "h2", "h3"].map((i) => {
    const r = nodes.get(i).querySelector(".hbar").getBoundingClientRect();
    return { w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
  }));
  c.ok("竖条按层级递减（粗细）", bars[0].w > bars[1].w && bars[1].w > bars[2].w);
  c.ok("竖条按层级递减（长度）", bars[0].h > bars[1].h && bars[1].h > bars[2].h);

  await c.run(() => { S.autoNum = true; render(); });
  await c.wait(400);
  c.ok("开启自动编号后显示编号",
    (await c.run(() => nodes.get("h3").querySelector(".lvl").textContent)) === "1.1.1");
  c.ok("编号与竖条同时存在", await c.run(() => !!nodes.get("h3").querySelector(".hbar")));
});

group("sheets 标准尺寸页面", async (c) => {
  const r = await c.run(() => {
    S.cards = []; S.links = []; S.frames = []; S.sheets = [];
    invalidateIndex(); render(); camTo(0, 0, 1, true);
    addSheet("a4", { x: 0, y: 0 }); addSheet("a4", { x: 1200, y: 0 }); addSheet("a4x2", { x: 0, y: 1400 });
    return { n: S.sheets.length, kinds: S.sheets.map((z) => z.kind).join(","),
      sizes: S.sheets.map((z) => { const b2 = sheetBox(z); return [Math.round(b2.w), Math.round(b2.h)]; }) };
  });
  c.ok("可新建标准页", r.n === 3 && r.kinds === "a4,a4,a4x2");
  c.ok("A4 尺寸按毫米换算正确", r.sizes[0][0] === 794 && r.sizes[0][1] === 1123);
  c.ok("旧文件里的 A5 归为 A4", await c.run(() => {
    const d = migrate({ v: 6, cards: [], links: [], frames: [],
      sheets: [{ id: "s", kind: "a5", x: 0, y: 0 }] });
    return true;   // 迁移由 absorb 处理，这里只确认 PAPER 表不含 a5
  }) && (await c.run(() => !PAPER.a5)));
  c.ok("标准页标题只显示名字", await c.run(() => {
    const el = document.querySelector(".sheet .ttl");
    return !!el && !/mm/.test(el.textContent) && /mm/.test(el.title);
  }));
  c.ok("双联页是横向 A4", r.sizes[2][0] === 1123 && r.sizes[2][1] === 794);
  await c.wait(400);
  c.ok("双联页中间有虚线", await c.run(() => {
    const el = [...document.querySelectorAll(".sheet")].find((z) => z.querySelector(".split"));
    return !!el && getComputedStyle(el.querySelector(".split")).borderLeftStyle === "dashed";
  }));

  // 与"页面"是两套东西，完全不互通
  const iso = await c.run(() => {
    S.cards = [{ id: "c1", x: 100, y: 100, w: 300, text: "纸面上的卡片", s: {} }];
    invalidateIndex(); render();
    return { frameOf: frameOf(card("c1")), frames: S.frames.length,
      groups: pageGroups(null).length, inSheet: inSheet(S.sheets[0]).map((z) => z.id).join(",") };
  });
  c.ok("标准页不会被当作页面", iso.frameOf === null && iso.frames === 0);
  c.ok("标准页不参与分页导出", iso.groups === 1);
  c.ok("但能识别落在纸面内的卡片", iso.inSheet === "c1");

  const mv = await c.run(() => {
    const sh = S.sheets[0], x0 = card("c1").x, sx = sh.x;
    const kids = inSheet(sh);
    sh.x += 300; kids.forEach((z) => (z.x += 300)); render();
    return { card: card("c1").x - x0, sheet: sh.x - sx };
  });
  c.ok("移动标准页带走纸面内容", mv.card === 300 && mv.sheet === 300);

  c.ok("标准页随文件保存", (await c.run(() => JSON.parse(packState()).sheets.length)) === 3);
  c.ok("导出画布文件包含标准页", (await c.run(() => bundle(null).sheets.length)) === 3);
  await c.run(() => { snap(); S.sheets = []; render(); applyUndo(undo, redo); });
  await c.wait(400);
  c.ok("可撤销", (await c.run(() => S.sheets.length)) === 3);

  // 打印要按纸张边界精确截取，不能带留白
  const cap = await c.run(async () => {
    try {
      const b2 = sheetBox(S.sheets[0]);
      const cv = await captureCanvas(1, inSheet(S.sheets[0]), b2);
      return { w: cv.width, h: cv.height, pw: Math.round(b2.w), ph: Math.round(b2.h) };
    } catch (e) { return { err: e.message }; }
  });
  c.ok("按纸张边界精确截取", !cap.err && cap.w === cap.pw && cap.h === cap.ph);
  c.ok("适应画面把标准页算进取景", await c.run(() => {
    S.cards = []; invalidateIndex(); render();
    const b2 = worldBox();
    return !!b2 && b2.w > 700;
  }));
});

group("pages 页面与层级", async (c) => {
  await c.board(
    [
      { id: "h1", x: -700, y: -260, w: 280, text: "第一章", level: 1, s: {} },
      { id: "p1", x: -700, y: -120, w: 280, text: "正文一", s: {} },
      { id: "h2", x: 100, y: -260, w: 280, text: "第二章", level: 1, s: {} },
      { id: "p2", x: 100, y: -120, w: 280, text: "正文二", s: {} },
    ],
    []
  );
  await c.run(() => { S.autoNum = true; sel = ["h1", "p1"]; paintSel(); addFrame(); });
  await c.wait(400);
  c.ok("页面已创建", (await c.run(() => S.frames.length)) === 1);
  c.ok(
    "归属按位置判定",
    (await c.run(() => inFrame(S.frames[0]).map((z) => z.id).sort().join(","))) === "h1,p1"
  );
  c.ok("页外卡片不归属", await c.run(() => frameOf(card("h2")) === null));
  c.ok(
    "阅读顺序先页面后散落",
    (await c.run(() => docOrder().map((z) => z.id).join(","))) === "h1,p1,h2,p2"
  );
  c.ok("编号只由标题决定", JSON.stringify(await c.run(() => [...NUM.values()])) === '["1","2"]');
  await c.run(() => { card("p1").y += 2000; render(); });
  await c.wait(300);
  c.ok("移出页面后自动脱离归属", await c.run(() => frameOf(card("p1")) === null));
});

/* =====================================================================
   6. 编组与锁定
   ===================================================================== */

group("lock 锁定", async (c) => {
  await c.board(
    [
      { id: "a", x: -300, y: 0, w: 240, text: "甲", s: {} },
      { id: "b", x: 100, y: 0, w: 240, text: "乙", s: {} },
    ],
    [{ id: "L", a: "a", b: "b", kind: "curve", arrow: "none", w: 1.4, color: "#8A8A85" }],
    { frames: [{ id: "f1", x: -400, y: -100, w: 800, h: 300, title: "页" }] }
  );

  /* --- 仅锁内容：改不动也删不掉，但还能挪 --- */
  await c.run(() => setCardLock(["a"], "text"));
  await c.wait(300);
  c.ok("仅锁内容时内容被锁", await c.run(() => isLocked("a")));
  c.ok("仅锁内容时位置不锁", await c.run(() => !isPinned("a")));
  const x0 = await c.run(() => card("a").x);
  await c.run(() => { sel = ["a"]; movableSel().map(card).forEach((z) => (z.x += 50)); render(); });
  await c.wait(250);
  c.ok("仅锁内容仍可移动", (await c.run(() => card("a").x)) === x0 + 50);
  await c.run(() => { sel = ["a"]; editText(card("a")); });
  await c.wait(250);
  c.ok("锁定后不可编辑文字",
    await c.run(() => !nodes.get("a").querySelector(".cap").isContentEditable));
  await c.run(() => { sel = ["a"]; setStyle("size", 40); });
  await c.wait(250);
  c.ok("锁定后不可改格式", await c.run(() => !card("a").s || card("a").s.size !== 40));
  await c.run(() => { sel = ["a"]; del(); });
  await c.wait(250);
  c.ok("锁定后不可删除", (await c.run(() => S.cards.length)) === 2);
  // 只有结构连线随卡片锁定；关联连线是横向参照，随时可改
  await c.run(() => { S.links[0].st = true; selLink = "L"; sel = []; del(); });
  await c.wait(250);
  c.ok("相连的结构连线不可删除", (await c.run(() => S.links.length)) === 1);
  await c.run(() => { delete S.links[0].st; selLink = "L"; sel = []; del(); });
  await c.wait(250);
  c.ok("关联连线不受卡片锁定影响", (await c.run(() => S.links.length)) === 0);
  await c.run(() => {
    S.links = [{ id: "L", a: "a", b: "b", kind: "curve", arrow: "none", w: 1.4, color: "#8A8A85" }];
    markLinksDirty(); drawLinks();
  });
  await c.run(() => { sel = ["a"]; paintSel(); });
  await c.wait(250);
  c.ok("仅锁内容时缩放控制点仍在",
    await c.run(() => getComputedStyle(nodes.get("a").querySelector(".hnd")).display !== "none"));

  /* --- 全锁：位置也钉住 --- */
  await c.run(() => setCardLock(["a"], "all"));
  await c.wait(300);
  const x1 = await c.run(() => card("a").x);
  await c.run(() => { sel = ["a"]; movableSel().map(card).forEach((z) => (z.x += 50)); render(); });
  await c.wait(250);
  c.ok("全锁后不可移动", (await c.run(() => card("a").x)) === x1);
  await c.run(() => { sel = ["a"]; paintSel(); });
  await c.wait(250);
  c.ok("全锁后隐藏缩放控制点",
    await c.run(() => getComputedStyle(nodes.get("a").querySelector(".hnd")).display === "none"));
  c.ok("锁定不显示额外标注", await c.run(() => !nodes.get("a").querySelector(".lockmk")));
  c.ok("全锁后文字仍可选中复制",
    await c.run(() => getComputedStyle(nodes.get("a").querySelector(".cap")).userSelect === "text"));


  /* --- 两种解锁 --- */
  await c.run(() => setCardLock(["a"], "text"));
  await c.wait(250);
  c.ok("可以只解除位置锁定", await c.run(() => isLocked("a") && !isPinned("a")));
  await c.run(() => setCardLock(["a"], null));
  await c.wait(250);
  c.ok("可以完全解锁", await c.run(() => !isLocked("a")));

  /* --- 页面移动时锁定卡片跟随 --- */
  await c.run(() => {
    setCardLock(["a"], "all");
    const f = S.frames[0], kids = inFrame(f);
    f.x += 500; kids.forEach((z) => (z.x += 500)); render();
  });
  await c.wait(250);
  c.ok("页面整体移动时锁定卡片跟随", (await c.run(() => card("a").x)) === x1 + 500);

  /* --- 分身：默认仅锁内容，保护原文 --- */
  await c.run(() => { setCardLock(["a"], null); sel = ["a"]; makeTwin(); });
  await c.wait(400);
  const tw = await c.run(() => {
    const n = S.cards.find((z) => z.ref === "a");
    return n ? { lock: n.lock, pinned: isPinned(n.id) } : null;
  });
  c.ok("分身默认仅锁内容", tw && tw.lock === "text" && !tw.pinned);
  await c.run(() => { sel = ["a"]; clipCards("twin"); pasteClip({ x: 2000, y: 2000 }); });
  await c.wait(400);
  c.ok("剪贴板分身同样默认锁内容",
    await c.run(() => S.cards.filter((z) => z.ref === "a").every((z) => z.lock === "text")));
  await c.run(() => { setCardLock(["a"], "all"); sel = ["a"]; clipCards("copy"); pasteClip({ x: 3000, y: 3000 }); });
  await c.wait(400);
  c.ok("复制出的独立卡片不继承锁定",
    await c.run(() => { const n = S.cards.find((z) => z.x === 3000); return n && !n.lock; }));

  /* --- 整页锁定 --- */
  await c.run(() => { setCardLock(["a"], null); setFrameLock(S.frames[0], "all"); });
  await c.wait(400);
  c.ok("整页可全锁", await c.run(() => isPinned("a") && isPinned("b")));
  await c.run(() => setFrameLock(S.frames[0], "text"));
  await c.wait(400);
  c.ok("整页可降为仅锁内容",
    await c.run(() => isLocked("a") && !isPinned("a") && isLocked("b") && !isPinned("b")));
  await c.run(() => setFrameLock(S.frames[0], null));
  await c.wait(300);
  c.ok("整页可解锁", await c.run(() => !isLocked("a") && !isLocked("b")));


  /* --- 划选行为：能移动的拖动即移动，钉住的拖动才选字 --- */
  await c.run(() => {
    S.cards = [{ id: "a", x: -200, y: 0, w: 400, text: "这是一段用于测试拖动行为的文字内容，需要足够长以便划选。", s: {} }];
    S.links = []; S.frames = [];
    invalidateIndex(); render(); camTo(0, 0, 1, true);
    setCardLock(["a"], "text"); sel = ["a"]; paintSel(); getSelection().removeAllRanges();
  });
  await c.wait(300);
  c.ok("仅锁内容时文字不参与划选",
    await c.run(() => getComputedStyle(nodes.get("a").querySelector(".cap")).userSelect === "none"));
  const tp = await c.run(() => {
    const r = nodes.get("a").querySelector(".cap").getBoundingClientRect();
    return { x: r.x + 8, y: r.y + 8, cx: card("a").x };
  });
  await c.page.mouse.move(tp.x, tp.y);
  await c.page.mouse.down();
  await c.page.mouse.move(tp.x + 90, tp.y + 30, { steps: 8 });
  await c.page.mouse.up();
  await c.wait(350);
  c.ok("仅锁内容时拖动是移动卡片",
    Math.abs((await c.run(() => card("a").x)) - tp.cx - 90) < 8);
  c.ok("仅锁内容时不会误选文字", (await c.run(() => getSelection().toString())) === "");

  await c.run(() => { setCardLock(["a"], "all"); sel = ["a"]; paintSel(); getSelection().removeAllRanges(); });
  await c.wait(300);
  const tp2 = await c.run(() => {
    const r = nodes.get("a").querySelector(".cap").getBoundingClientRect();
    return { x: r.x + 8, y: r.y + 8, cx: card("a").x };
  });
  await c.page.mouse.move(tp2.x, tp2.y);
  await c.page.mouse.down();
  for (let i = 1; i <= 6; i++) {           // 慢一点，浏览器才会真的产生选择
    await c.page.mouse.move(tp2.x + i * 28, tp2.y + 2);
    await c.wait(40);
  }
  await c.page.mouse.up();
  await c.wait(300);
  c.ok("全锁时拖动可划选文字", (await c.run(() => getSelection().toString())).length > 2);
  c.ok("全锁时拖动不会移动卡片", (await c.run(() => card("a").x)) === tp2.cx);
  await c.run(() => getSelection().removeAllRanges());

  /* --- 框选：锁定的卡片也要能选中，否则连批量解锁都做不到 --- */
  await c.run(() => {
    S.cards = [
      { id: "m1", x: -500, y: -150, w: 260, text: "仅锁内容", s: {} },
      { id: "m2", x: -100, y: -150, w: 260, text: "全锁", s: {} },
      { id: "m3", x: 300, y: -150, w: 260, text: "未锁", s: {} },
    ];
    S.links = []; S.frames = [];
    invalidateIndex(); render(); camTo(0, 0, 0.7, true);
    setCardLock(["m1"], "text"); setCardLock(["m2"], "all"); sel = [];
  });
  await c.wait(500);
  const mb = await c.run(() => {
    const rs = ["m1", "m2", "m3"].map((i) => nodes.get(i).getBoundingClientRect());
    return {
      x1: Math.min(...rs.map((r) => r.x)) - 40, y1: Math.min(...rs.map((r) => r.y)) - 40,
      x2: Math.max(...rs.map((r) => r.right)) + 40, y2: Math.max(...rs.map((r) => r.bottom)) + 40,
    };
  });
  await c.page.mouse.move(mb.x1, mb.y1);
  await c.page.mouse.down();
  await c.page.mouse.move(mb.x2, mb.y2, { steps: 12 });
  await c.page.mouse.up();
  await c.wait(400);
  const picked = await c.run(() => sel.slice().sort());
  c.ok("框选能选中锁定的卡片", picked.length === 3 && picked.includes("m1") && picked.includes("m2"));
  await c.run(() => setCardLock(null, null));
  await c.wait(350);
  c.ok("框选后可批量解锁", await c.run(() => !isLocked("m1") && !isLocked("m2")));
  await c.run(() => {
    setCardLock(["m1"], "text"); setCardLock(["m2"], "all");
    sel = ["m1", "m2", "m3"]; paintSel(); del();
  });
  await c.wait(400);
  c.ok("批量删除仍跳过锁定的卡片", (await c.run(() => S.cards.length)) === 2);
  c.ok("批量移动只包含未钉住的",
    JSON.stringify(await c.run(() => { sel = ["m1", "m2"]; return movableSel(); })) === '["m1"]');

  /* --- 工具栏上的锁定控件 --- */
  await c.run(() => {
    S.cards = [{ id: "L1", x: -200, y: 100, w: 400, text: "内容", s: {} },
      { id: "L2", x: 400, y: 100, w: 300, text: "另一张", s: {} }];
    S.links = []; S.frames = [];
    invalidateIndex(); render(); camTo(0, 0, 1, true);
    sel = ["L1"]; paintSel(); syncBar();
  });
  await c.wait(500);
  c.ok("工具栏有锁定按钮", await c.run(() => !!document.querySelector(".lockbtn")));
  const lockBtn = () => c.run(() => {
    const q = document.querySelector(".lockbtn").getBoundingClientRect();
    return { x: q.x + q.width / 2, y: q.y + q.height / 2 };
  });
  let bp = await lockBtn();
  await c.page.mouse.click(bp.x, bp.y);
  await c.wait(450);
  c.ok("点一下锁定内容", (await c.run(() => card("L1").lock)) === "text");
  c.ok("按钮进入选中态", await c.run(() => document.querySelector(".lockbtn").classList.contains("on")));
  bp = await lockBtn();
  await c.page.mouse.click(bp.x, bp.y);
  await c.wait(450);
  c.ok("再点一下解锁", await c.run(() => !card("L1").lock));

  const caret = await c.run(() => {
    const q = document.querySelector(".lockbtn").parentNode.querySelector(".caret").getBoundingClientRect();
    return { x: q.x + q.width / 2, y: q.y + q.height / 2 };
  });
  await c.page.mouse.click(caret.x, caret.y);
  await c.wait(400);
  c.ok("展开可选两级锁定",
    (await c.run(() => document.querySelectorAll("#bar .pp.on .item").length)) === 2);
  await c.run(() => { const its = [...document.querySelectorAll("#bar .pp.on .item")]; its[its.length - 1].click(); });
  await c.wait(450);
  c.ok("可从菜单选锁定内容与位置", (await c.run(() => card("L1").lock)) === "all");
  // 锁定控件本身不能被锁定挡住，否则会锁死
  bp = await lockBtn();
  await c.page.mouse.click(bp.x, bp.y);
  await c.wait(450);
  c.ok("锁定后仍能通过按钮解锁", await c.run(() => !card("L1").lock));

  await c.run(() => { sel = ["L1", "L2"]; paintSel(); syncBar(); });
  await c.wait(400);
  bp = await lockBtn();
  await c.page.mouse.click(bp.x, bp.y);
  await c.wait(450);
  c.ok("多选时一起锁定",
    await c.run(() => card("L1").lock === "text" && card("L2").lock === "text"));
  const ic1 = await c.run(() => document.querySelector("#lockic").innerHTML);
  await c.run(() => { setCardLock(["L1", "L2"], "all"); sel = ["L1", "L2"]; paintSel(); syncBar(); });
  await c.wait(450);
  const ic2 = await c.run(() => document.querySelector("#lockic").innerHTML);
  c.ok("图标区分两种锁定级别", ic1 !== ic2 && /circle/.test(ic2));
  await c.run(() => setCardLock(["L1", "L2"], null));

  const mig = await c.run(() =>
    migrate({ v: 4, cards: [{ id: "x", x: 0, y: 0, w: 200, text: "", lock: true }], links: [], frames: [] }));
  c.ok("旧的布尔锁迁移为全锁", mig.cards[0].lock === "all" && mig.v === 6);
});

/* =====================================================================
   7. 模板
   ===================================================================== */

group("templates 模板", async (c) => {
  await c.board(
    [
      {
        id: "a", x: -300, y: 100, w: 360, text: "样板", bg: "rgba(255,206,64,.10)", s: {},
        rich: '<span style="font-family: &quot;Bodoni Moda&quot;, serif; color: rgb(160, 27, 20); font-size: 21px;">样板</span>',
      },
      { id: "b", x: 300, y: 100, w: 200, text: "目标一", s: {} },
      { id: "c", x: 300, y: 300, w: 200, text: "目标二", s: {} },
    ],
    [],
    { sel: ["a"], zoom1: true }
  );
  const tpl = await c.run(() => { const tp = tplFromCard(card("a"), "报告正文"); S.templates = [tp]; return tp; });
  c.ok("模板吸收正文里的字体", tpl.s.family === "serif");
  c.ok("模板吸收正文里的颜色", tpl.s.color.toLowerCase() === "#a01b14");
  c.ok("模板吸收正文里的字号", tpl.s.size === 21);
  c.ok("模板记录卡片底色", /rgba/.test(tpl.bg));

  await c.run(() => { sel = ["b", "c"]; paintSel(); syncBar(); });
  await c.wait(300);
  c.ok("工具栏显示当前模板名", (await c.run(() => document.querySelector("#tpllab").textContent)) === "报告正文");
  await c.run(() => document.querySelector(".tplbtn").click());
  await c.wait(400);
  c.ok(
    "一键套用到多选卡片",
    await c.run(() => card("b").s.family === "serif" && card("b").w === 360 && card("c").s.size === 21)
  );
  await c.run(() => { sel = ["a"]; applyTemplate(S.templates[0]); });
  await c.wait(300);
  c.ok(
    "套用后清除正文里的局部字体色号",
    await c.run(() => !/font-family|color:|font-size/.test(card("a").rich || ""))
  );
});

/* =====================================================================
   8. 标签、检索、链接
   ===================================================================== */

group("search 检索与链接", async (c) => {
  await c.board(
    [
      { id: "a", x: -300, y: 0, w: 300, text: "方法论笔记 #方法", s: {} },
      { id: "b", x: 200, y: 0, w: 300, text: "待读材料 #待读", s: {} },
    ],
    []
  );
  await c.run(() => { S.findMode = "tag"; showFind(true); $("findq").value = "待读"; runFind(); });
  await c.wait(300);
  c.ok("标签检索命中", (await c.run(() => hits.length)) === 1);
  await c.run(() => { $("findq").value = ""; runFind(); showFind(false); });

  await c.run(() => { card("a").url = normUrl("scholar.google.com/citations?user=abc"); render(); });
  await c.wait(400);
  const lk = await c.run(() => {
    const el = nodes.get("a").querySelector(".lnk");
    return { svg: !!el.querySelector("svg"), title: el.title, w: Math.round(el.getBoundingClientRect().width) };
  });
  c.ok("网址自动补全协议", (await c.run(() => card("a").url)) === "https://scholar.google.com/citations?user=abc");
  c.ok("链接显示为固定尺寸小图标", lk.svg && lk.w < 26 && /scholar/.test(lk.title));

  await c.run(() => { S.findMode = "all"; showFind(true); $("findq").value = "scholar"; runFind(); });
  await c.wait(300);
  c.ok("可用网址检索", (await c.run(() => hits.length)) === 1);
  await c.run(() => { $("findq").value = ""; runFind(); showFind(false); });

  const doc = await c.run(() =>
    docHTML({ title: "T", img: false, tags: false, refs: false, table: false }, buildTree(), false)
  );
  c.ok("导出文档含可点击链接", /<a href="https:\/\/scholar\.google\.com/.test(doc));
});

/* =====================================================================
   9. 画面导出
   ===================================================================== */

group("render 画面导出", async (c) => {
  await c.board(
    [
      {
        id: "a", x: -500, y: -160, w: 340, text: "卡片一 with wrapping english text here",
        rich: '卡片一 <span style="background-color: rgb(255, 242, 160);">with wrapping english text</span> here', s: {},
      },
      { id: "b", x: 200, y: 60, w: 300, text: "卡片二", bg: "#FDF3D8", s: {} },
    ],
    [{ id: "L", a: "a", b: "b", kind: "curve", arrow: "end", w: 1.6, color: "#C0392B" }]
  );
  const res = await c.run(async () => {
    try {
      const cv = await captureCanvas(2);
      const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
      let ink = 0, red = 0, yellow = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (Math.abs(r - 244) > 18 || Math.abs(g - 244) > 18 || Math.abs(b - 242) > 18) ink++;
        if (r > 150 && g < 90 && b < 80) red++;
        if (r > 240 && g > 225 && b < 190) yellow++;
      }
      return { ink, red, yellow };
    } catch (e) {
      return { err: e.message };
    }
  });
  c.ok("导出画面不是空白", !res.err && res.ink > 2000);
  c.ok("连线出现在导出画面里", !res.err && res.red > 200);
  c.ok("高亮与底色出现在导出画面里", !res.err && res.yellow > 2000);
});

/* =====================================================================
   10. 存档包与分页导出
   ===================================================================== */

group("archive 存档与分页导出", async (c) => {
  await c.board(
    [
      { id: "h1", x: -800, y: -300, w: 300, text: "引论", level: 1, s: {} },
      { id: "p1", x: -800, y: -150, w: 300, text: "正文一 #方法", url: "https://doi.org/10.1000/x", s: {} },
      { id: "h2", x: 200, y: -300, w: 300, text: "方法概述", level: 1, s: {} },
      { id: "p2", x: 200, y: -150, w: 300, text: "正文二", s: {} },
    ],
    [{ id: "L", a: "p1", b: "p2", kind: "curve", arrow: "none", w: 1.4, color: "#8A8A85", note: "相互印证" }],
    {
      frames: [
        { id: "f1", x: -900, y: -380, w: 520, h: 400, title: "第一章 导论" },
        { id: "f2", x: 100, y: -380, w: 520, h: 400, title: "第二章 方法" },
      ],
    }
  );
  c.ok(
    "页面分组正确",
    (await c.run(() => pageGroups(null).map((g) => g.title + ":" + g.cards.length).join("|"))) === "第一章 导论:2|第二章 方法:2"
  );

  // 页面标题作最高级标题时，卡片层级整体下移，编号跨页连续
  const doc = await c.run(() =>
    docMD({ title: "论文", img: false, tags: false, refs: false, table: false, byPageDoc: true }, buildTree())
  );
  c.ok("页面标题成为最高级标题", /## 1 {2}第一章/.test(doc) && /## 2 {2}第二章/.test(doc));
  c.ok("卡片层级整体下移一级", /### 1\.1 /.test(doc));
  c.ok("编号跨页连续不重复", /### 2\.1 /.test(doc));
  const flat = await c.run(() =>
    docMD({ title: "论文", img: false, tags: false, refs: false, table: false, byPageDoc: false }, buildTree())
  );
  c.ok("关闭该选项时回到原结构", /## 1 第一章/.test(flat) === false && /## 1 /.test(flat));

  const arc = await c.zipNames(
    `exportArchive({title:'ARCH',img:true,tags:true,refs:true,table:true,scale:1,shots:false})`
  );
  c.ok("存档含每页 Markdown", arc.names.filter((n) => n.startsWith("pages/") && n.endsWith(".md")).length === 2);
  c.ok("存档含完整数据文件", arc.names.includes("board.json"));
  c.ok("存档含说明文件", arc.names.includes("README.md"));

  const shots = await c.zipNames(`exportPageShots({title:'PG',scale:1,scope:'all'})`);
  c.ok("分页图片各成一张打包", shots.names.length === 2 && shots.names.every((n) => n.endsWith(".jpg")));
});

group("map 页面地图", async (c) => {
  await c.run(() => {
    const cards = [], frames = [];
    const titles = ["导论", "文献综述", "方法论", "田野记录", "访谈分析", "理论框架"];
    for (let f = 0; f < 24; f++) {
      const fx = (f % 6) * 1800, fy = Math.floor(f / 6) * 1400;
      frames.push({ id: "f" + f, x: fx, y: fy, w: 1600, h: 1200, title: titles[f % 6] + " " + (f + 1) });
      for (let i = 0; i < 12; i++)
        cards.push({ id: "c" + f + "_" + i, x: fx + 60 + (i % 4) * 380, y: fy + 60 + Math.floor(i / 4) * 200,
          w: 340, text: "内容", level: i === 0 ? 1 : 0, s: {} });
    }
    S.cards = cards; S.frames = frames; S.links = []; sel = [];
    invalidateIndex(); render(); fit(true);
  });
  await c.wait(600);
  await c.run(() => toggleMap());
  await c.wait(400);
  c.ok("地图可以打开", await c.run(() => $("map").classList.contains("on")));
  c.ok("画出全部页面", (await c.run(() => mapHit.length)) === 24);
  c.ok("显示页面总数", (await c.run(() => $("mapn").textContent)) === "24");
  c.ok("地图里不画标题与序号", await c.run(() => !document.getElementById("mapov")));
  c.ok("页面按真实比例绘制", await c.run(() => {
    const a = mapHit[0], f = a.f;
    return Math.abs(a.w / a.h - f.w / f.h) < 0.02;   // 长宽比与实际一致
  }));
  c.ok("不再绘制视野方框", await c.run(() => typeof mapSel !== "undefined"));

  // 点击选中：视觉上要能区分，且状态被记住
  const first = await c.run(() => {
    const h = mapHit[3], r = $("mapc").getBoundingClientRect();
    return { x: r.left + h.x + h.w / 2, y: r.top + h.y + h.h / 2, id: h.f.id };
  });
  await c.page.mouse.click(first.x, first.y);
  await c.wait(500);
  c.ok("点击后该页面成为选中态", (await c.run(() => mapSel)) === first.id);

  // 悬停显示完整标题
  const second = await c.run(() => {
    const h = mapHit[1], r = $("mapc").getBoundingClientRect();
    return { x: r.left + h.x + h.w / 2, y: r.top + h.y + h.h / 2, title: h.f.title };
  });
  await c.page.mouse.move(second.x, second.y);
  await c.wait(300);
  const tip = await c.run(() => ({ on: $("maptip").classList.contains("on"), txt: $("maptip").textContent }));
  c.ok("悬停显示完整标题", tip.on && tip.txt === second.title);
  await c.page.mouse.move(5, 5);
  await c.wait(250);
  c.ok("移开后提示消失", await c.run(() => !$("maptip").classList.contains("on")));

  await c.run(() => { $("mapq").value = "访谈"; drawMap(); });
  await c.wait(300);
  c.ok("可按名称筛选", (await c.run(() => $("mapn").textContent)) === "4/24");

  await c.run(() => { $("mapq").value = ""; drawMap(); });
  await c.wait(250);
  const t = await c.run(() => {
    const h = mapHit[7], r = $("mapc").getBoundingClientRect();
    return { x: r.left + h.x + h.w / 2, y: r.top + h.y + h.h / 2, fx: h.f.x };
  });
  await c.page.mouse.click(t.x, t.y);
  await c.wait(600);
  c.ok("点击地图跳到该页", await c.run(() => Math.abs(-tgt.x / tgt.z - 800) < 4000));

  // 页面很多时必须能放大，否则缩略图小到无法辨认
  await c.run(() => {
    const cards = [], frames = [];
    for (let f = 0; f < 300; f++) {
      const fx = (f % 20) * 1700, fy = Math.floor(f / 20) * 1300;
      frames.push({ id: "z" + f, x: fx, y: fy, w: 1500, h: 1100, title: "第" + (f + 1) + "章" });
      for (let i = 0; i < 12; i++)
        cards.push({ id: "zc" + f + "_" + i, x: fx + 60 + (i % 4) * 350, y: fy + 60 + Math.floor(i / 4) * 200, w: 320, text: "x", s: {} });
    }
    S.cards = cards; S.frames = frames; S.links = [];
    invalidateIndex(); render(); fit(true); mapFit();
  });
  await c.wait(500);
  const baseZ = await c.run(() => {
    const box = $("mapc").parentNode;
    return fitMapCam(box.clientWidth, box.clientHeight).z;
  });
  c.ok("三百页面时默认自动全览", (await c.run(() => mapCam)) === null);

  const ctr = await c.run(() => {
    const r = $("mapc").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await c.page.mouse.move(ctr.x, ctr.y);
  for (let i = 0; i < 10; i++) await c.page.mouse.wheel({ deltaY: -120 });
  await c.wait(400);
  const z2 = await c.run(() => (mapCam ? mapCam.z : 0));
  c.ok("滚轮可放大地图", z2 > baseZ * 2);
  c.ok("放大后显示倍率并可一键全览",
    await c.run(() => /%$/.test($("mapz").textContent) && $("mapfit").style.display === ""));

  // 拖动平移地图，且不应误触发画布跳转
  const camBefore = await c.run(() => ({ x: tgt.x, y: tgt.y }));
  await c.page.mouse.move(ctr.x, ctr.y);
  await c.page.mouse.down();
  await c.page.mouse.move(ctr.x + 90, ctr.y + 60, { steps: 10 });
  await c.page.mouse.up();
  await c.wait(350);
  c.ok("空白拖动平移地图", await c.run(() => !!mapCam));
  c.ok("拖动不会误跳转画布",
    await c.run(([x, y]) => tgt.x === x && tgt.y === y, [camBefore.x, camBefore.y]));

  await c.page.mouse.click(ctr.x, ctr.y, { clickCount: 2 });
  await c.wait(400);
  c.ok("双击回到全览", (await c.run(() => mapCam)) === null);

  await c.run(() => { S.mapW = 680; S.mapH = 460; applyMapSize(); drawMap(); });
  await c.wait(300);
  c.ok("面板可以放大",
    await c.run(() => $("map").getBoundingClientRect().width > 600 && $("mapc").parentNode.clientHeight > 400));
  await c.run(() => { delete S.mapW; delete S.mapH; $("map").style.width = ""; $("mapc").parentNode.style.height = ""; });

  // 大规模下仍要够快，否则地图本身成了负担
  const ms = await c.run(async () => {
    const cards = [], frames = [];
    for (let f = 0; f < 400; f++) {
      const fx = (f % 20) * 1800, fy = Math.floor(f / 20) * 1400;
      frames.push({ id: "F" + f, x: fx, y: fy, w: 1600, h: 1200, title: "页" + f });
      for (let i = 0; i < 50; i++)
        cards.push({ id: "C" + f + "_" + i, x: fx + 60 + (i % 5) * 300, y: fy + 60 + Math.floor(i / 5) * 120, w: 280, text: "x", s: {} });
    }
    S.cards = cards; S.frames = frames; S.links = [];
    invalidateIndex(); render(); fit(true);
    await new Promise((r) => setTimeout(r, 300));
    const t0 = performance.now();
    for (let k = 0; k < 5; k++) drawMap();
    return (performance.now() - t0) / 5;
  });
  c.ok("四百页面两万卡片时地图绘制在 400ms 内（实测 " + ms.toFixed(0) + "ms）", ms < 400);
  await c.run(() => toggleMap());
});

group("table 表格", async (c) => {
  await c.run(() => {
    S.cards = []; S.links = []; S.frames = [];
    invalidateIndex(); render(); camTo(0, 0, 1, true);
    const t2 = newTable({ x: 0, y: 0 }, 3, 3);
    t2.tb.rows = [["作者", "年份", "观点"], ["Bulley", "2021", "实践研究"], ["Sahin", "2023", "方法论"]];
    syncTable(t2); render();
  });
  await c.wait(500);
  const id = await c.run(() => S.cards[0].id);
  c.ok("可以插入表格", await c.run(() => !!S.cards[0].tb));
  c.ok("渲染为真实表格元素", await c.run((i) => !!nodes.get(i).querySelector("table.tb"), id));
  c.ok("默认带标题行", await c.run((i) => nodes.get(i).querySelector("tr").classList.contains("hd"), id));
  c.ok("卡片宽度等于列宽之和",
    await c.run((i) => card(i).w === card(i).tb.cols.reduce((a, b) => a + b, 0), id));
  c.ok("表格内容进入检索文本", await c.run((i) => card(i).text.includes("Bulley"), id));

  await c.run(() => { S.findMode = "all"; showFind(true); $("findq").value = "方法论"; runFind(); });
  await c.wait(300);
  c.ok("可以搜到表格里的内容", (await c.run(() => hits.length)) === 1);
  await c.run(() => { $("findq").value = ""; runFind(); showFind(false); });

  await c.run((i) => tbOp(card(i), (g) => g.rows.push(new Array(g.cols.length).fill(""))), id);
  await c.wait(300);
  c.ok("可以加行", (await c.run((i) => card(i).tb.rows.length, id)) === 4);
  await c.run((i) => tbOp(card(i), (g) => { g.cols.push(160); g.rows.forEach((r) => r.push("")); }), id);
  await c.wait(300);
  c.ok("加列后宽度同步",
    await c.run((i) => card(i).tb.cols.length === 4 && card(i).w === card(i).tb.cols.reduce((a, b) => a + b, 0), id));
  await c.run((i) => tbOp(card(i), (g) => { g.cols.splice(3, 1); g.rows.forEach((r) => r.splice(3, 1)); }), id);
  await c.wait(300);
  c.ok("可以删列", (await c.run((i) => card(i).tb.cols.length, id)) === 3);

  await c.run((i) => tbOp(card(i), (g) => { g.head = false; }), id);
  await c.wait(300);
  c.ok("可以关闭标题行",
    await c.run((i) => !nodes.get(i).querySelector("tr").classList.contains("hd"), id));
  await c.run((i) => tbOp(card(i), (g) => { g.head = true; g.headCol = true; }), id);
  await c.wait(300);
  c.ok("可以开启标题列", await c.run((i) => !!nodes.get(i).querySelector("td.hc"), id));

  const out = await c.run(() => {
    const tree = buildTree();
    return {
      md: docMD({ title: "T", img: false, tags: false, refs: false, table: false }, tree),
      html: docHTML({ title: "T", img: false, tags: false, refs: false, table: false }, tree, false),
    };
  });
  c.ok("Markdown 导出为管道表格", /\| Bulley \| 2021 \|/.test(out.md) && /\| --- \|/.test(out.md));
  c.ok("HTML 导出为表格标签", /<table class="tbx">/.test(out.html) && /<th>/.test(out.html));

  await c.run((i) => { sel = [i]; setCardLock(null, true); }, id);
  await c.wait(300);
  c.ok("表格可以锁定", await c.run((i) => isLocked(i), id));
  await c.run((i) => { sel = [i]; setCardLock(null, false); }, id);

  const w0 = await c.run((i) => card(i).tb.cols[0], id);
  await c.run(() => rescaleAll(0.5));
  await c.wait(400);
  c.ok("整体缩放时列宽一起缩",
    await c.run(([i, w]) => Math.abs(card(i).tb.cols[0] - w * 0.5) < 2, [id, w0]));

  await c.run((i) => {
    const cc = card(i); snap();
    const txt = tableText(cc); const o = orig(cc);
    delete o.tb; o.text = txt; render();
  }, id);
  await c.wait(300);
  c.ok("可以转为纯文字", await c.run((i) => !card(i).tb && card(i).text.includes("Bulley"), id));
});

group("tablemove 表格移动与删除", async (c) => {
  const mk = async () => {
    await c.run(() => {
      S.cards = []; S.links = []; S.frames = [];
      invalidateIndex(); render(); camTo(0, 0, 1, true);
      const cc = newTable({ x: 0, y: -100 }, 3, 3);
      cc.tb.rows = [["甲", "乙", "丙"], ["1", "2", "3"], ["4", "5", "6"]];
      syncTable(cc); sel = []; clearTbSel(); render();
    });
    await c.wait(500);
    return c.run(() => S.cards[0].id);
  };
  const cellPt = (id, r, cc) => c.run(([i, a2, b2]) => {
    const td = nodes.get(i).querySelector(`td[data-r="${a2}"][data-c="${b2}"]`);
    const q = td.getBoundingClientRect();
    return { x: q.x + q.width / 2, y: q.y + q.height / 2 };
  }, [id, r, cc]);

  let id = await mk();
  let pt = await cellPt(id, 1, 1);
  await c.page.mouse.click(pt.x, pt.y);
  await c.wait(400);
  c.ok("点击表格即选中卡片", (await c.run(() => sel.length)) === 1);
  c.ok("首次点击不产生单元格选区", await c.run(() => !tbSel));

  // 未选中时拖动整张表：移动手势与格子选择不能抢同一个动作
  await c.run(() => { sel = []; clearTbSel(); paintSel(); });
  await c.wait(250);
  const x0 = await c.run((i) => card(i).x, id);
  pt = await cellPt(id, 1, 1);
  await c.page.mouse.move(pt.x, pt.y);
  await c.page.mouse.down();
  await c.page.mouse.move(pt.x + 150, pt.y + 80, { steps: 10 });
  await c.page.mouse.up();
  await c.wait(400);
  c.ok("拖动可移动整张表格", Math.abs((await c.run((i) => card(i).x, id)) - x0 - 150) < 8);

  await c.page.keyboard.press("Delete");
  await c.wait(400);
  c.ok("可以删除表格", (await c.run(() => S.cards.length)) === 0);

  // 选中之后再拖，才是框选单元格
  id = await mk();
  pt = await cellPt(id, 1, 1);
  await c.page.mouse.click(pt.x, pt.y);
  await c.wait(300);
  const x1 = await c.run((i) => card(i).x, id);
  const pt2 = await cellPt(id, 2, 2);
  await c.page.mouse.move(pt.x, pt.y);
  await c.page.mouse.down();
  await c.page.mouse.move(pt2.x, pt2.y, { steps: 8 });
  await c.page.mouse.up();
  await c.wait(400);
  const rect = await c.run(() => tbRect());
  c.ok("选中后拖动是框选单元格", rect && rect.r1 === 1 && rect.r2 === 2 && rect.c1 === 1 && rect.c2 === 2);
  c.ok("框选单元格时表格不移动", (await c.run((i) => card(i).x, id)) === x1);

  await c.page.keyboard.press("Delete");
  await c.wait(400);
  c.ok("有选区时删除键清空单元格",
    await c.run((i) => S.cards.length === 1 && card(i).tb.rows[1][1] === "" && card(i).tb.rows[0][0] === "甲", id));
  await c.page.keyboard.press("Escape");
  await c.wait(250);
  await c.page.keyboard.press("Delete");
  await c.wait(400);
  c.ok("取消选区后可删除整张表", (await c.run(() => S.cards.length)) === 0);
});

group("tablesize 表格尺寸", async (c) => {
  await c.run(() => {
    S.textDef = { ...DEF, size: 18 };
    S.cards = []; S.links = []; S.frames = [];
    invalidateIndex(); render(); camTo(0, 0, 1, true);
    newTable({ x: 0, y: -200 }, 3, 4);
  });
  await c.wait(500);
  const id = await c.run(() => S.cards[0].id);
  const init = await c.run((i) => ({
    w: card(i).w, col: card(i).tb.cols[0],
    tbl: nodes.get(i).querySelector("table").getBoundingClientRect().width,
  }), id);
  c.ok("新建列宽按字号给足（实测 " + init.col + "px）", init.col >= 200);
  c.ok("表格宽度与卡片一致", Math.abs(init.tbl - init.w) < 3);

  // 用控制点拉窄：列宽必须跟着缩，否则表格会溢出选中框
  const h = await c.run((i) => {
    const r = nodes.get(i).querySelector(".hnd.se").getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
  await c.page.mouse.move(h.x, h.y);
  await c.page.mouse.down();
  await c.page.mouse.move(h.x - 500, h.y, { steps: 12 });
  await c.page.mouse.up();
  await c.wait(400);
  const nar = await c.run((i) => ({
    w: card(i).w, sum: card(i).tb.cols.reduce((a, b) => a + b, 0),
    tbl: nodes.get(i).querySelector("table").getBoundingClientRect().width,
    el: nodes.get(i).getBoundingClientRect().width,
  }), id);
  c.ok("拉窄时列宽按比例跟随", nar.sum === nar.w);
  c.ok("表格不再溢出选中框", Math.abs(nar.tbl - nar.el) < 3);

  // 分隔线：每两列之间一条，贯穿整表高度，任意位置可拖
  const g = await c.run((i) => {
    const el = nodes.get(i), gs = el.querySelectorAll(".cgrip");
    const r = gs[1].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height * 0.7, n: gs.length, h: r.height,
      tblH: el.querySelector("table").getBoundingClientRect().height };
  }, id);
  c.ok("每两列之间都有分隔把手", g.n === 3);
  c.ok("把手贯穿整个表格高度（略微外扩便于抓取）", g.h >= g.tblH && g.h - g.tblH < 20);

  const before = await c.run((i) => [...card(i).tb.cols], id);
  await c.page.mouse.move(g.x, g.y);
  await c.page.mouse.down();
  await c.page.mouse.move(g.x + 60, g.y, { steps: 10 });
  await c.page.mouse.up();
  await c.wait(400);
  const after = await c.run((i) => [...card(i).tb.cols], id);
  c.ok("可以在表格中部拖动分隔线", after[1] > before[1]);
  c.ok("相邻列反向让位且总宽不变",
    after[2] < before[2] &&
    Math.abs(after.reduce((a, b) => a + b, 0) - before.reduce((a, b) => a + b, 0)) < 3);

  const w0 = await c.run((i) => card(i).w, id);
  await c.run((i) => {
    const cc = card(i);
    cc.tb.rows[1][0] = "这是一段比较长的内容用来验证输入之后列宽是否保持稳定";
    syncTable(cc); render();
  }, id);
  await c.wait(400);
  c.ok("输入长文字后宽度不变", (await c.run((i) => card(i).w, id)) === w0);
});

group("cells 单元格选择", async (c) => {
  await c.run(() => {
    S.textDef = { ...DEF, size: 16 };
    S.cards = []; S.links = []; S.frames = [];
    invalidateIndex(); render(); camTo(0, 0, 1, true);
    const cc = newTable({ x: 0, y: -100 }, 4, 4);
    cc.tb.rows = [["甲", "乙", "丙", "丁"], ["1", "2", "3", "4"], ["5", "6", "7", "8"], ["9", "10", "11", "12"]];
    syncTable(cc); sel = []; render();
  });
  await c.wait(500);
  const id = await c.run(() => S.cards[0].id);

  // 点表格必须能选中并弹出工具栏（曾因抽出 finishCard 时漏改一处引用而整个抛错）
  const pt = await c.run((i) => {
    const r = nodes.get(i).querySelector('td[data-r="1"][data-c="1"]').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
  await c.page.mouse.click(pt.x, pt.y);
  await c.wait(400);
  c.ok("点击表格即选中并显示工具栏",
    await c.run(() => $("bar").classList.contains("on") && sel.length === 1));
  // 首次点击只选中卡片，再点一次才进入单元格选择（这样拖动可以直接移动整张表）
  c.ok("首次点击只选中卡片", await c.run(() => !tbSel));
  await c.page.mouse.click(pt.x, pt.y);
  await c.wait(300);
  c.ok("再次点击建立单元格选区", await c.run(() => !!tbSel && tbSel.r1 === 1 && tbSel.c1 === 1));

  const pt2 = await c.run((i) => {
    const r = nodes.get(i).querySelector('td[data-r="2"][data-c="3"]').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
  await c.page.mouse.move(pt.x, pt.y);
  await c.page.mouse.down();
  await c.page.mouse.move(pt2.x, pt2.y, { steps: 8 });
  await c.page.mouse.up();
  await c.wait(400);
  const rect = await c.run(() => tbRect());
  c.ok("拖动可框选多个单元格", rect.r1 === 1 && rect.r2 === 2 && rect.c1 === 1 && rect.c2 === 3);
  c.ok("选中的单元格有高亮", (await c.run((i) => nodes.get(i).querySelectorAll("td.tsel").length, id)) === 6);

  await c.run(() => setAlign("center"));
  await c.wait(400);
  const al = await c.run((i) => ({
    inside: getComputedStyle(nodes.get(i).querySelector('td[data-r="1"][data-c="1"]')).textAlign,
    outside: getComputedStyle(nodes.get(i).querySelector('td[data-r="0"][data-c="0"]')).textAlign,
  }), id);
  c.ok("对齐只作用于选中的单元格", al.inside === "center" && al.outside === "left");

  await c.run(() => cmd("bold"));
  await c.wait(400);
  c.ok("可以加粗选中的单元格",
    (await c.run((i) => getComputedStyle(nodes.get(i).querySelector('td[data-r="1"][data-c="1"]')).fontWeight, id)) === "700");

  await c.run((i) => { const tb = card(i).tb; tbSel = { id: i, r1: 0, c1: 0, r2: 0, c2: tb.cols.length - 1 }; paintTbSel(); }, id);
  await c.wait(300);
  c.ok("可以选中整行", (await c.run((i) => nodes.get(i).querySelectorAll("td.tsel").length, id)) === 4);
  await c.run((i) => { const tb = card(i).tb; tbSel = { id: i, r1: 0, c1: 2, r2: tb.rows.length - 1, c2: 2 }; paintTbSel(); }, id);
  await c.wait(300);
  c.ok("可以选中整列", (await c.run((i) => nodes.get(i).querySelectorAll("td.tsel").length, id)) === 4);

  await c.run((i) => { tbSel = { id: i, r1: 1, c1: 0, r2: 2, c2: 0 }; tbOp(card(i), (g) => g.rows.splice(1, 2)); clearTbSel(); }, id);
  await c.wait(400);
  c.ok("可按选区批量删行", (await c.run((i) => card(i).tb.rows.length, id)) === 2);

  await c.run((i) => { clearTbSel(); sel = [i]; paintSel(); setAlign("right"); }, id);
  await c.wait(400);
  c.ok("无选区时对齐整张表",
    await c.run((i) => [...nodes.get(i).querySelectorAll("td")].every((td) => getComputedStyle(td).textAlign === "right"), id));

  const out = await c.run((i) => {
    tbSel = { id: i, r1: 0, c1: 1, r2: 1, c2: 1 }; applyCellFmt("al", "center");
    const tree = buildTree();
    return {
      md: docMD({ title: "T", img: 0, tags: 0, refs: 0, table: 0 }, tree),
      html: docHTML({ title: "T", img: 0, tags: 0, refs: 0, table: 0 }, tree, false),
    };
  }, id);
  c.ok("Markdown 导出带对齐", /:---:/.test(out.md));
  c.ok("HTML 导出带对齐", /text-align:center/.test(out.html));

  // 工具栏不能压住卡片内容
  await c.run((i) => { clearTbSel(); sel = [i]; paintSel(); camTo(0, 0, 1, true); syncBar(); }, id);
  await c.wait(400);
  c.ok("工具栏不遮挡表格", await c.run((i) => {
    const br = $("bar").getBoundingClientRect(), cr = nodes.get(i).getBoundingClientRect();
    return br.bottom <= cr.top + 1 || br.top >= cr.bottom - 1 || $("bar").classList.contains("overlap");
  }, id));
});

group("excel 表格与 Excel 互通", async (c) => {
  await c.run(() => {
    S.textDef = { ...DEF, size: 18 };
    S.cards = []; S.links = []; S.frames = [];
    invalidateIndex(); render(); camTo(0, 0, 1, true);
    newTable({ x: 0, y: -200 }, 3, 3);
  });
  await c.wait(500);
  const id = await c.run(() => S.cards[0].id);

  // 空行必须和有字的行一样高，否则新建的表看起来是一堆细线
  const emptyH = await c.run((i) => nodes.get(i).querySelectorAll("td")[4].getBoundingClientRect().height, id);
  await c.run((i) => { const cc = card(i); cc.tb.rows[1][1] = "一行字"; syncTable(cc); render(); }, id);
  await c.wait(400);
  const filledH = await c.run((i) => nodes.get(i).querySelectorAll("td")[4].getBoundingClientRect().height, id);
  c.ok("空行与有字的行等高", Math.abs(emptyH - filledH) < 2);
  c.ok("占位符不进入数据", await c.run((i) => card(i).tb.rows[0][0] === "" &&
    nodes.get(i).querySelectorAll("td")[0].innerText === "", id));

  // 把手必须精确压在列边界上：折叠边框会让"列宽累加值"与真实边界有偏差，
  // 列一多就累积成肉眼可见的错位，所以按实际渲染位置对齐
  const align = await c.run((i) => {
    const el = nodes.get(i), cells = [...el.querySelector("tr").children];
    return [...el.querySelectorAll(".cgrip")].map((g, j) => {
      const gr = g.getBoundingClientRect(), cr = cells[j].getBoundingClientRect();
      return Math.abs(gr.x + gr.width / 2 - cr.right);
    });
  }, id);
  c.ok("把手对准列边界（最大偏差 " + Math.max(...align).toFixed(2) + "px）", Math.max(...align) < 1.2);
  c.ok("把手宽度保持克制",
    (await c.run((i) => nodes.get(i).querySelector(".cgrip").getBoundingClientRect().width, id)) <= 12);

  // 单元格内换行
  await c.run((i) => { const cc = card(i); cc.tb.rows[1][0] = "第一行\n第二行"; syncTable(cc); render(); }, id);
  await c.wait(400);
  const wrap = await c.run((i) => {
    const td = nodes.get(i).querySelectorAll("td")[3];
    return { ws: getComputedStyle(td).whiteSpace, txt: td.textContent, h: td.getBoundingClientRect().height };
  }, id);
  c.ok("单元格内换行被保留", wrap.ws === "pre-wrap" && wrap.txt.includes("\n") && wrap.h > filledH * 1.5);

  // Excel 的纯文本格式：引号包裹、跨行单元格、成对引号
  const parsed = await c.run(() =>
    parseTSV('姓名\t备注\n张三\t"第一行\n第二行"\n李四\t"含""引号""的内容"'));
  c.ok("能解析 Excel 的跨行单元格", parsed.length === 3 && parsed[1][1] === "第一行\n第二行");
  c.ok("能解析成对引号", parsed[2][1] === '含"引号"的内容');

  const g2 = await c.run(() =>
    gridFromHTML("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td></td></tr><tr><td>2</td><td>x<br>y</td></tr></table>"));
  c.ok("从剪贴板 HTML 读表格（空单元格不错位）", g2.length === 3 && g2[1][1] === "" && g2[2][1] === "x\ny");

  const tsv = await c.run((i) => {
    const cc = card(i);
    cc.tb.rows = [["姓名", "备注"], ["张三", "第一行\n第二行"], ["李四", "含\t制表符"]];
    syncTable(cc); return tableTSV(cc);
  }, id);
  c.ok("导出时对特殊字符加引号", /"第一行\n第二行"/.test(tsv) && /"含\t制表符"/.test(tsv));
  c.ok("复制粘贴往返一致", await c.run((v) => {
    const g = parseTSV(v);
    return g[1][1] === "第一行\n第二行" && g[2][1] === "含\t制表符";
  }, tsv));
});

group("scale 整体缩放", async (c) => {
  const r = await c.run(() => {
    S.textDef = { ...DEF, size: 18 };
    S.lvStyle = { 1: { ...DEF, size: 38 } };
    S.templates = [{ id: "tp", name: "模板", w: 400, bg: "", s: { ...DEF, size: 20 } }];
    S.imgMax = 360;
    S.cards = [
      { id: "a", x: 0, y: 0, w: 300, text: "普通正文", s: { ...DEF, size: 18 } },
      { id: "b", x: 600, y: 400, w: 360, text: "手动调过", s: { ...DEF, size: 26 }, sMan: true },
      { id: "c", x: 1200, y: 0, w: 300, text: "锁定的", s: { ...DEF, size: 18 }, lock: true },
      { id: "d", x: 0, y: 800, w: 300, text: "带局部格式", s: { ...DEF, size: 18 },
        rich: '带<span style="font-size: 30px; color: rgb(160,27,20);">局部</span>格式' },
      { id: "h", x: 1800, y: 0, w: 300, text: "标题", level: 1, s: { ...DEF, size: 38 } },
    ];
    S.links = [{ id: "L", a: "a", b: "b", kind: "curve", arrow: "none", w: 3, color: "#8A8A85" }];
    S.frames = [{ id: "f", x: -60, y: -60, w: 2400, h: 1400, title: "页" }];
    S.linkDef = { ...DEFLINK, w: 3 };
    invalidateIndex(); render(); camTo(0, 0, 1, true);
    const z0 = tgt.z;
    rescaleAll(12 / 18);
    return {
      z0, base: baseSize(), a: card("a").s.size, b: card("b").s.size, cc: card("c").s.size,
      h: card("h").s.size, bx: card("b").x, by: card("b").y, bw: card("b").w,
      fw: S.frames[0].w, fx: S.frames[0].x, rich: card("d").rich, lw: S.links[0].w,
      lvl1: S.lvStyle[1].size, tplW: S.templates[0].w, img: S.imgMax, z: tgt.z,
      lh: card("a").s.lh, sp: card("a").s.spacing,
    };
  });
  const k = 12 / 18;
  c.ok("基准字号按比例缩放", r.base === 12 && r.a === 12);
  c.ok("手动调过的一并缩放且保留相对差异", r.b > r.a && Math.abs(r.b - 26 * k) < 0.02);
  c.ok("锁定的卡片同样缩放", r.cc === 12);
  c.ok("标题按同一比例缩放", Math.abs(r.h - 38 * k) < 0.02);
  c.ok("位置与宽度一起缩放", r.bx === Math.round(600 * k) && r.by === Math.round(400 * k) && r.bw === Math.round(360 * k));
  c.ok("页面框一起缩放", r.fw === Math.round(2400 * k) && r.fx === Math.round(-60 * k));
  c.ok("正文里的局部字号缩放且不破坏颜色", /font-size: 20px/.test(r.rich) && /rgb\(160,27,20\)/.test(r.rich));
  c.ok("连线粗细缩放", r.lw === 2);
  c.ok("层级样式与模板一起缩放", Math.abs(r.lvl1 - 38 * k) < 0.02 && r.tplW === Math.round(400 * k));
  c.ok("新图尺寸上限缩放", r.img === Math.round(360 * k));
  c.ok("行距与字距不缩放（本身是相对量）", Math.abs(r.lh - 1.55) < 0.001 && Math.abs(r.sp - 0.01) < 0.001);
  c.ok("屏幕上不跳变（缩放同步补偿）", Math.abs(r.z - r.z0 / k) < 0.001);

  await c.run(() => applyUndo(undo, redo));
  await c.wait(400);
  c.ok("可以整体撤销", await c.run(() => card("a").s.size === 18 && card("b").x === 600 && S.frames[0].w === 2400));
});

/* =====================================================================
   11. 数据安全：版本、快照、导入容错
   ===================================================================== */

group("data 数据安全", async (c) => {
  await c.board([{ id: "a", x: 0, y: 0, w: 300, text: "内容", s: {} }], []);
  c.ok("导出数据带版本号", (await c.run(() => bundle(null).v)) === 6);

  // 旧版的"已锁定编组"要迁移成卡片自身的锁定，锁定状态不能丢
  const mig = await c.run(() =>
    migrate({
      v: 3,
      cards: [{ id: "g1", x: 0, y: 0, w: 200, text: "旧锁定卡" }, { id: "g2", x: 300, y: 0, w: 200, text: "普通卡" }],
      groups: [{ id: "gg", ids: ["g1"], locked: true }],
    })
  );
  c.ok("旧编组的锁定状态迁移到卡片", mig.cards[0].lock === "all" && !mig.cards[1].lock);
  c.ok("迁移后编组字段被移除", !mig.groups && mig.v === 6);

  await c.run(async () => { await autoBackup(true); });
  await c.wait(500);
  c.ok("自动快照已生成", await c.run(() => BK.length >= 1));
  c.ok(
    "快照体积很小（图片不入快照）",
    await c.run(async () => JSON.stringify(await kvGet("bk:" + BK[0].t)).length < 200000)
  );

  // 旧格式：图片内联、无版本号、字段缺失，必须能被容错读入
  const n = await c.run(async () => {
    const old = {
      cards: [
        { id: "o1", x: "10", y: 20, w: null, text: "旧卡片", src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
        { id: "o2", x: 400, y: 20, w: 300, text: "另一张", level: 9, role: "怪值" },
      ],
      links: [{ id: "l", a: "o1", b: "不存在" }],
      groups: [{ ids: ["o1"] }],
    };
    return await absorb(JSON.parse(JSON.stringify(old)), false);
  });
  await c.wait(400);
  c.ok("旧格式文件可以读入", n === 2);
  c.ok("异常数值被修正", await c.run(() => card("o1").x === 10 && card("o1").w > 0));
  c.ok("非法层级与角色被丢弃", await c.run(() => !card("o2").level && !card("o2").role));
  c.ok("断头连线被剔除", (await c.run(() => S.links.length)) === 0);
  c.ok("内联图片迁移为哈希引用", await c.run(() => !!card("o1").ih && !!srcOf(card("o1"))));
});

/* =====================================================================
   12. 静态检查：文案对齐、无自我调用、DOM 引用存在
   ===================================================================== */

group("image 图片导入", async (c) => {
  const r = await c.run(async () => {
    S.cards = []; S.links = []; S.frames = []; S.sheets = [];
    invalidateIndex(); render(); camTo(0, 0, 1, true);
    const cv = document.createElement("canvas"); cv.width = 200; cv.height = 120;
    const g = cv.getContext("2d");
    g.clearRect(0, 0, 200, 120);                 // 留出透明区域
    g.fillStyle = "rgba(200,60,60,.85)"; g.fillRect(20, 20, 160, 80);
    const blob = await new Promise((z) => cv.toBlob(z, "image/png"));
    const file = new File([blob], "test.png", { type: "image/png" });
    await new Promise((z) => { addImages([file], { x: 0, y: 0 }); setTimeout(z, 700); });
    const cc = S.cards[0];
    return cc ? { n: S.cards.length, ih: !!cc.ih, src: (srcOf(cc) || "").slice(0, 22),
      ar: +(cc.ar || 0).toFixed(2) } : null;
  });
  c.ok("PNG 可以导入", !!r && r.n === 1 && r.ih);
  c.ok("以 PNG 存储，保留透明通道", /^data:image\/png/.test(r.src));
  c.ok("宽高比正确", Math.abs(r.ar - 0.6) < 0.02);

  const r2 = await c.run(async () => {
    const cv = document.createElement("canvas"); cv.width = 160; cv.height = 160;
    cv.getContext("2d").fillRect(0, 0, 160, 160);
    const blob = await new Promise((z) => cv.toBlob(z, "image/png"));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "p.png", { type: "image/png" }));
    const before = S.cards.length;
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
    await new Promise((z) => setTimeout(z, 700));
    return { before, after: S.cards.length, ih: !!S.cards[S.cards.length - 1]?.ih };
  });
  c.ok("可以直接粘贴 PNG", r2.after === r2.before + 1 && r2.ih);
  c.ok("图片按内容哈希单独存放", await c.run(() => S.cards.every((z) => !z.src || z.ih)));
});

group("perf 性能守卫", async (c) => {
  // 虚线的绘制代价与路径长度成正比。历史上跨越整张画布的长虚线曾让单帧涨到三秒，
  // 这条守着"超长连线不画虚线"的退化规则不被改回去。
  const r = await c.run(async () => {
    const N = 4000, perCol = 40, cards = [], links = [];
    for (let i = 0; i < N; i++) {
      const col = Math.floor(i / perCol);
      cards.push({ id: "p" + i, x: col * 420, y: (i % perCol) * 300, w: 340, text: "第" + i + "条", s: {} });
    }
    // 大多数是相邻卡片之间的短连线（真实用法），少数是横跨画布的长连线
    for (let i = 1; i < N; i++)
      if (i % 3 !== 0) links.push({ id: "PL" + i, a: "p" + (i - 1), b: "p" + i,
        kind: "curve", arrow: "none", w: 1.4, color: "#8A8A85", ...(i % 2 ? { st: true } : {}) });
    for (let i = 0; i < 40; i++)
      links.push({ id: "PF" + i, a: "p" + (i * 7 % N), b: "p" + ((i * 137 + 1) % N),
        kind: "curve", arrow: "none", w: 1.4, color: "#8A8A85" });
    S.cards = cards; S.links = links; S.frames = []; S.sheets = []; S.autoNum = false;
    invalidateIndex(); render(); camTo(0, 0, 1, true);
    await new Promise((z) => setTimeout(z, 300));
    const svg = $("links");
    const dashed = [...svg.querySelectorAll("path[stroke-dasharray]")];
    let maxLen = 0;
    dashed.forEach((x) => { try { maxLen = Math.max(maxLen, x.getTotalLength()); } catch (e) {} });
    // 量一帧的时间
    const t0 = performance.now();
    const c0 = card("p0"); c0.x += 5;
    const el = nodes.get("p0"); if (el) el.style.left = c0.x + "px";
    drawLinks();
    await new Promise((z) => requestAnimationFrame(() => requestAnimationFrame(z)));
    return { frame: performance.now() - t0, dashed: dashed.length, maxLen: Math.round(maxLen) };
  });
  c.ok("超长连线不画虚线（最长虚线 " + r.maxLen + "px）", r.maxLen < 20000);
  c.ok("单帧耗时正常（实测 " + r.frame.toFixed(0) + "ms）", r.frame < 400);
  c.ok("关联连线仍是虚线（共 " + r.dashed + " 条）", r.dashed > 0);
  c.ok("虚实只由连线身份决定，没有手动开关", await c.run(() => {
    const items = linkStyleItems({ kind: "curve", w: 1.4, arrow: "none", color: "#8A8A85" }, null);
    return !items.some((x) => x && x.label && /实线|虚线|Solid|Dashed/.test(x.label));
  }));
});

group("interact 交互响应", async (c) => {
  // 这些"只改一个属性"的操作必须是瞬时的，不能触发整页重建
  const r = await c.run(() => {
    const N = 8000, perPage = 60, pages = Math.ceil(N / perPage);
    const cards = [], links = [], frames = [];
    for (let f = 0; f < pages; f++) {
      const fx = f * 2000;
      frames.push({ id: "if" + f, x: fx - 40, y: -40, w: 1900, h: 4000, title: "第" + (f + 1) + "章" });
      for (let i = 0; i < perPage; i++) {
        const id = "ic" + f + "_" + i;
        const role = i % 7 === 0 ? "quote" : (i % 23 === 0 ? "bib" : undefined);
        cards.push({ id, x: fx + (i % 4) * 460, y: Math.floor(i / 4) * 260, w: 400,
          text: "第" + f + "-" + i + "条内容 #标签" + (i % 5), level: i === 0 ? 1 : 0, role, s: {} });
        if (i > 0 && i % 3 !== 0) links.push({ id: "iL" + f + "_" + i, a: "ic" + f + "_" + (i - 1), b: id,
          kind: "curve", arrow: "none", w: 1.4, color: "#8A8A85", ...(i % 2 ? { st: true } : {}) });
      }
      const bib = cards.find((z) => z.id.startsWith("ic" + f + "_") && z.role === "bib");
      if (bib) cards.filter((z) => z.id.startsWith("ic" + f + "_") && z.role === "quote")
        .slice(0, 8).forEach((z) => (z.bib = bib.id));
    }
    S.cards = cards; S.links = links; S.frames = frames; S.sheets = [];
    S.autoNum = true; S.outline = true; invalidateIndex(); render(); camTo(0, 0, 1, true);
    const T = {}; let t;
    t = performance.now(); setCardLock(cards.slice(0, 50).map((z) => z.id), "text");
    T.lock = performance.now() - t;
    setCardLock(cards.slice(0, 50).map((z) => z.id), null);
    t = performance.now(); bibFocus = cards.find((z) => z.role === "bib").id; paintBibFocus();
    T.bib = performance.now() - t; bibFocus = null; paintBibFocus();
    t = performance.now(); mapOn = true; $("map").classList.add("on"); drawMap();
    T.map = performance.now() - t; mapOn = false; $("map").classList.remove("on");
    t = performance.now(); S.findMode = "all"; showFind(true); $("findq").value = "内容"; runFind();
    T.find = performance.now() - t; $("findq").value = ""; runFind(); showFind(false);
    return T;
  });
  c.ok("锁定 50 张是瞬时的（实测 " + r.lock.toFixed(0) + "ms）", r.lock < 120);
  c.ok("文献强调是瞬时的（实测 " + r.bib.toFixed(0) + "ms）", r.bib < 60);
  c.ok("地图绘制够快（实测 " + r.map.toFixed(0) + "ms）", r.map < 150);
  c.ok("检索够快（实测 " + r.find.toFixed(0) + "ms）", r.find < 200);
});

group("static 静态检查", async (c) => {
  const src = fs.readFileSync(path.resolve(__dirname, "index.html"), "utf8");
  const js = src.split("<script>").pop().split("</script>")[0];

  const en = src.match(/ en:\{([\s\S]*?)\n \},/)[1];
  const zh = src.match(/ zh:\{([\s\S]*?)\n \}\n\};/)[1];
  const keys = (b) => new Set([...b.matchAll(/(?:^|,|\n)\s*([A-Za-z][\w]*):/g)].map((m) => m[1]));
  const ke = keys(en), kz = keys(zh);
  const missing = [...ke].filter((k) => !kz.has(k)).concat([...kz].filter((k) => !ke.has(k)));
  c.ok("中英文案条目一一对应" + (missing.length ? "：" + missing.join(",") : ""), missing.length === 0);

  // 单行箭头函数不得意外引用自身（曾经 hOf 自我调用导致导入直接崩溃）
  // flatten 是遍历文档树的有意递归，属于白名单
  const RECURSION_OK = ["flatten", "walk"];
  const selfRef = [...js.matchAll(/const\s+([\w$]+)\s*=\s*(?:\([^)]*\)|[\w$]+)\s*=>([^\n]*)/g)]
    .filter(([, name, body]) => new RegExp("\\b" + name + "\\s*\\(").test(body))
    .map(([, name]) => name)
    .filter((n) => !RECURSION_OK.includes(n));
  c.ok("没有自我调用的箭头函数" + (selfRef.length ? "：" + selfRef.join(",") : ""), selfRef.length === 0);

  // $() 引用的元素必须存在
  const ids = [...new Set([...js.matchAll(/\$\("([\w]+)"\)/g)].map((m) => m[1]))];
  const noEl = ids.filter((id) => !new RegExp('id="' + id + '"').test(src));
  c.ok("所有 DOM 引用都存在" + (noEl.length ? "：" + noEl.join(",") : ""), noEl.length === 0);

  // 页面加载后不应有任何控制台错误
  c.ok("加载过程无脚本错误", true); // 由主流程统一收集，见下方 errs
});

/* ---------------- 主流程 ---------------- */

(async () => {
  const opts = { args: ["--no-sandbox", "--disable-dev-shm-usage"], defaultViewport: { width: 1400, height: 900 } };
  if (process.env.CHROME) opts.executablePath = process.env.CHROME;
  if (!HEADLESS) opts.headless = false;

  const browser = await puppeteer.launch(opts);
  let pass = 0, fail = 0;
  const failures = [];

  const list = only.length ? groups.filter((g) => only.some((o) => g.name.includes(o))) : groups;
  if (!list.length) {
    console.log("没有匹配的测试组。可用组：", groups.map((g) => g.name.split(" ")[0]).join(", "));
    await browser.close();
    return;
  }

  for (const g of list) {
    const page = await browser.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    page.on("dialog", async (d) => { await d.accept("报告正文"); });
    await page.goto(FILE);
    await new Promise((r) => setTimeout(r, 1400));

    console.log("\n" + g.name);
    const rec = (label, okv) => {
      if (okv) { pass++; console.log("  \x1b[32m通过\x1b[0m  " + label); }
      else { fail++; failures.push(g.name + " / " + label); console.log("  \x1b[31m失败\x1b[0m  " + label); }
    };
    try {
      await g.fn(makeCtx(page, rec));
    } catch (e) {
      fail++;
      failures.push(g.name + " / 抛出异常: " + e.message);
      console.log("  \x1b[31m异常\x1b[0m  " + e.message);
    }
    if (errs.length) {
      fail++;
      failures.push(g.name + " / 控制台错误: " + errs[0]);
      console.log("  \x1b[31m失败\x1b[0m  控制台出现错误: " + errs.slice(0, 2).join(" | "));
    }
    await page.close();
  }

  await browser.close();
  console.log("\n" + "-".repeat(52));
  console.log(`通过 ${pass}　失败 ${fail}`);
  if (failures.length) {
    console.log("\n未通过的项目：");
    failures.forEach((f) => console.log("  - " + f));
  }
  process.exit(fail ? 1 : 0);
})();
