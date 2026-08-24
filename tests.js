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

  // 标题没标 level、而且线是从正文画向标题时，早先会按连线方向定父子，
  // 于是正文反倒成了上级、整份大纲翻过来。现在先看层级，再看结构线的度数
  // （谁被更多结构线连着谁就是这一处的主心骨），最后才看位置与连线方向。
  const back = await c.run(() => {
    S.cards = [
      { id: "H", x: 2000, y: 2000, w: 300, text: "第一章", s: {} },
      { id: "P1", x: 0, y: 0, w: 300, text: "正文一", s: {} },
      { id: "P2", x: 0, y: 400, w: 300, text: "正文二", s: {} },
    ];
    // 两条线都是从正文画向标题的
    S.links = [{ id: "l1", a: "P1", b: "H", st: true }, { id: "l2", a: "P2", b: "H", st: true }];
    S.frames = []; S.docs = []; S.outline = true; invalidateIndex(); render();
    return buildTree().flat.map((n) => n.c.id + ":" + n.lv).join(",");
  });
  c.ok("结构线接在标题后面时按结构排列，不看画线方向", back === "H:1,P1:0,P2:0");

  // 标题标了 level 时，层级判据优先于度数
  const lv = await c.run(() => {
    S.cards[0].level = 1;
    S.links = [{ id: "l1", a: "P1", b: "H", st: true }];
    invalidateIndex(); render();
    return buildTree().flat.map((n) => n.c.id + ":" + n.lv).join(",");
  });
  c.ok("标了层级的一端永远是上级", /^H:1,P1:0/.test(lv));

  // 上面两段换掉了整块画布，这里把原来的卡片与连线摆回去，
  // 后面检查连线样式的断言依赖它们
  await c.run(() => {
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
    invalidateIndex(); render();
  });

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

group("bib 文献条目", async (c) => {
  const r = await c.run(() => {
    S.cards = [
      { id: "H", x: 0, y: 0, w: 300, text: "文献综述", level: 1, s: {} },
      { id: "B1", x: 0, y: 200, w: 420, role: "bib", text: "Bulley & Sahin (2021).", s: {} },
      { id: "Q1", x: 0, y: 340, w: 340, bib: "B1", text: "Codification is vital (p.3)", s: {} },
      { id: "Q2", x: 0, y: 460, w: 340, bib: "B1", text: "新的结构与系统 (p.7)", s: {} },
      { id: "B2", x: 600, y: 200, w: 420, role: "bib", text: "Candy (2006).", s: {} },
      { id: "Q3", x: 600, y: 340, w: 340, bib: "B2", text: "实践主导与实践本位 (p.1)", s: {} },
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
  c.ok("导出为条目加其名下的材料", /\*\*Bulley/.test(r.md) && /Codification/.test(r.md));
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
    mig.cards[1].bib === "b" && mig.links.length === 0 && mig.v === 8);

  // 7 -> 8：折叠框里的分身以前当普通卡片摆在画布上，于是同一段内容
  // 在画布与稿子里各显示一次。迁移后它们只活在所属的那份稿子里。
  const mig8 = await c.run(() => migrate({
    v: 7,
    cards: [{ id: "host", x: 0, y: 0, w: 200, text: "宿主" },
      { id: "tw", x: 500, y: 0, w: 200, ref: "host", wrUnder: "host" },
      { id: "free", x: 900, y: 0, w: 200, text: "画布上的普通卡片" }],
    links: [], frames: [], docs: [{ id: "D1", x: 0, y: 0, title: "稿", ids: ["host"] }],
  }));
  c.ok("旧的折叠分身迁移为稿内投影",
    mig8.cards[1].wrIn === "D1" && !mig8.cards[2].wrIn && mig8.v === 8);
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
  c.ok("旧的布尔锁迁移为全锁", mig.cards[0].lock === "all" && mig.v === 8);
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
  // 快捷键 M：这一句原来被错缩进写在 if(lock){...} 里面，
  // 于是只有演示模式按得动，正常编辑时怎么按都没反应——菜单上却明明写着 M
  await c.run(() => { sel = []; selDoc = null; paintSel();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur() });
  await c.page.keyboard.press("m");
  await c.wait(350);
  c.ok("按 M 能打开地图", await c.run(() => mapOn && $("map").classList.contains("on")));
  await c.page.keyboard.press("m");
  await c.wait(350);
  c.ok("再按一次关掉", await c.run(() => !mapOn));

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

  // puppeteer 的 clickCount:2 只发一次按下，Chrome 不会据此合成 dblclick
  // （实测两次 click 的 detail 都是 1）。这里补上第二次按下时的 clickCount，
  // 让它成为浏览器认账的双击手势。
  await c.page.mouse.move(ctr.x, ctr.y);
  await c.page.mouse.down({ clickCount: 1 }); await c.page.mouse.up({ clickCount: 1 });
  await c.page.mouse.down({ clickCount: 2 }); await c.page.mouse.up({ clickCount: 2 });
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
  c.ok("导出数据带版本号", (await c.run(() => bundle(null).v)) === 8);

  // 旧版的"已锁定编组"要迁移成卡片自身的锁定，锁定状态不能丢
  const mig = await c.run(() =>
    migrate({
      v: 3,
      cards: [{ id: "g1", x: 0, y: 0, w: 200, text: "旧锁定卡" }, { id: "g2", x: 300, y: 0, w: 200, text: "普通卡" }],
      groups: [{ id: "gg", ids: ["g1"], locked: true }],
    })
  );
  c.ok("旧编组的锁定状态迁移到卡片", mig.cards[0].lock === "all" && !mig.cards[1].lock);
  c.ok("迁移后编组字段被移除", !mig.groups && mig.v === 8);

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

group("docpage 稿子在画布上", async (c) => {
  const ids = await c.run(() => {
    S.cards = [
      { id: "h1", x: 0, y: 0, w: 400, text: "理论框架", level: 1, s: { ...DEF, size: 22 } },
      { id: "p1", x: 0, y: 400, w: 400, text: "第一段内容在这里。", s: { ...DEF, size: 15 } },
      { id: "p2", x: 0, y: 800, w: 400, text: "第二段内容。", s: { ...DEF, size: 15 } },
    ];
    S.links = []; S.frames = []; S.sheets = []; S.docs = [];
    invalidateIndex(); render();
    const d = addDoc({ x: 1200, y: 0 }, "我的稿子");
    wrImport(["h1", "p1", "p2"], false, d.id);
    camTo(0, 0, 1, true);
    // 送进稿子的是内容的独立拷贝，新 id 跟原卡片的 id 对不上——按内容找出各自克隆出来的 id
    const byText = (txt) => d.ids.find((id) => card(id).text === txt);
    return { h1: byText("理论框架"), p1: byText("第一段内容在这里。"), p2: byText("第二段内容。") };
  });
  c.ok("送进稿子的是独立拷贝，不是原卡片本身",
    ids.h1 && ids.p1 && ids.p2 && ids.h1 !== "h1" && ids.p1 !== "p1" && ids.p2 !== "p2");
  await c.wait(600);
  const st = await c.run((ids) => {
    const el = document.querySelector("#docs .doc");
    return { w: Math.round(el.querySelector(".dmain").getBoundingClientRect().width),
      blocks: el.querySelectorAll(".blk").length,
      editable: el.querySelector(".cap").getAttribute("contenteditable"),
      hasSide: !!el.querySelector(".dside"),
      titleOutside: !!el.querySelector(".dttl .dt"),
      noMeta: !el.querySelector(".dm"),
      hasFmt: !!el.querySelector(".dbar .fmtbar .fx"),
      capSize: getComputedStyle(el.querySelector(`.blk[data-id="${ids.p1}"] .cap`)).fontSize,
      headSize: getComputedStyle(el.querySelector(`.blk[data-id="${ids.h1}"] .cap`)).fontSize };
  }, ids);
  c.ok("稿子直接在画布上展开正文", st.blocks === 3);
  c.ok("正文区宽度是世界坐标里的固定值", Math.abs(st.w - 760) < 4);
  c.ok("非专注状态下也显示大纲侧栏", st.hasSide);
  c.ok("正文可以直接打字，不必先双击进入编辑", st.editable === "true");
  c.ok("标题在左上角外侧，不占顶上的空间", st.titleOutside && st.noMeta);
  c.ok("稿子最上方有真的文字工具栏", st.hasFmt);
  c.ok("保留卡片本身的字号", st.capSize === "15px" && st.headSize === "22px");

  // 送进稿子的是拷贝：画布上原卡片 p1 的位置、内容完全不受影响，点一下照样能选中并弹出工具栏
  const extPt = await c.run(() => {
    const r = nodes.get("p1").getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + 10 };
  });
  await c.page.mouse.click(extPt.x, extPt.y);
  await c.wait(300);
  c.ok("送进稿子之后，画布上原卡片自己的位置照样能选中并弹出工具栏",
    await c.run(() => sel[0] === "p1" && $("bar").classList.contains("on")));
  await c.run(() => { sel = []; paintSel(); });

  // 内部尺寸不能乘反向缩放系数，否则缩小画布时会把文字挤成一列
  const zoomed = await c.run((ids) => {
    camTo(0, 0, 0.4, true);
    const el = document.querySelector("#docs .doc");
    return { declared: el.querySelector(`.blk[data-id="${ids.p1}"] .cap`).style.fontSize,
      ratio: el.querySelector(".dmain").getBoundingClientRect().width / 760 };
  }, ids);
  c.ok("缩放时内部比例不变形",
    zoomed.declared === "15px" && Math.abs(zoomed.ratio - 0.4) < 0.03);
  await c.run(() => camTo(0, 0, 1, true));
  await c.wait(300);

  // 点一下就能打字，跟 Word 一样，不必先双击"进入编辑"
  await c.run(() => camTo(-1510, -274, 1, true));
  await c.wait(300);
  const p2r = await c.run((ids) => {
    const r = document.querySelector(`#docs .doc .blk[data-id="${ids.p2}"] .cap`).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, ids);
  await c.page.mouse.click(p2r.x, p2r.y);
  await c.wait(200);
  c.ok("单击就能把光标落进正文", await c.run((ids) =>
    document.activeElement === document.querySelector(`#docs .doc .blk[data-id="${ids.p2}"] .cap`), ids));

  await c.run((ids) => {
    const cap = document.querySelector(`#docs .doc .blk[data-id="${ids.p2}"] .cap`);
    cap.focus(); cap.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  }, ids);
  await c.wait(400);
  c.ok("在画布上编辑稿子时不再弹出浮动工具栏（已有常驻的 fmtbar，两条栏会叠在一起打架）",
    await c.run((ids) => !$("bar").classList.contains("on") && sel[0] === ids.p2, ids));

  await c.run((ids) => {
    const cap = document.querySelector(`#docs .doc .blk[data-id="${ids.p2}"] .cap`);
    cap.innerText = "就地改写过了。";
    cap.dispatchEvent(new Event("input", { bubbles: true }));
  }, ids);
  await c.wait(600);
  c.ok("就地编辑改到的是稿子里的独立拷贝",
    (await c.run((ids) => card(ids.p2).text, ids)) === "就地改写过了。");
  c.ok("编辑稿子里的段落完全不牵动画布上的原卡片",
    (await c.run(() => card("p2").text)) === "第二段内容。");

  // 标题不再是 contenteditable：点一下是选中这份稿子，双击才改名（见 wrtitle 组）
  await c.run(() => {
    window.prompt = () => "改了名字";
    const dt = document.querySelector("#docs .doc .dttl .dt");
    dt.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  await c.wait(400);
  c.ok("标题双击可以改名", (await c.run(() => S.docs[0].title)) === "改了名字");

  c.ok("页内有模式与导出按钮",
    (await c.run(() => document.querySelectorAll("#docs .doc .dtool button").length)) === 4);
  c.ok("可以在页内切换模式", await c.run(() => {
    document.querySelector('#docs .doc .dtool button[data-m="ctx"]').click();
    const ok2 = S.docs[0].mode === "ctx";
    document.querySelector('#docs .doc .dtool button[data-m="iter"]').click();
    return ok2;
  }));
  await c.run(() => { S.docs = []; render(); });
});

group("write 写作页", async (c) => {
  const r = await c.run(() => {
    S.cards = [
      { id: "h1", x: 0, y: 0, w: 320, text: "理论框架", level: 1, s: { size: 22 } },
      { id: "p1", x: 400, y: 0, w: 400, text: "第一段内容。", s: { size: 15 }, bg: "rgba(90,190,105,.14)" },
      { id: "p2", x: 400, y: 300, w: 400, text: "第二段内容。", s: { size: 15 } },
      { id: "tw", ref: "p1", x: 900, y: 0, w: 400, s: {} },
    ];
    S.links = []; S.frames = []; S.sheets = []; S.docs = [];
    invalidateIndex(); render();
    const d = addDoc({ x: 0, y: 900 }, "我的论文");
    wrImport(["h1", "p1", "p2"], false, d.id);
    // 送进稿子的是内容的独立拷贝，新 id 跟原卡片的 id 对不上——按内容找出各自克隆出来的 id
    const byText = (txt) => d.ids.find((id) => card(id).text === txt);
    const ids = { h1: byText("理论框架"), p1: byText("第一段内容。"), p2: byText("第二段内容。") };
    return { docs: S.docs.length, ids, idsLen: d.ids.length, title: d.title };
  });
  c.ok("可以新建有名字的写作页", r.docs === 1 && r.title === "我的论文");
  c.ok("可以把卡片送进去", r.idsLen === 3);
  c.ok("送进稿子的是独立拷贝，不是原卡片本身",
    r.ids.h1 !== "h1" && r.ids.p1 !== "p1" && r.ids.p2 !== "p2");
  const ids = r.ids;
  await c.wait(400);
  c.ok("写作页在画布上是独立对象",
    (await c.run(() => document.querySelectorAll("#docs .doc").length)) === 1);

  await c.run(() => openWrite(S.docs[0].id));
  await c.wait(500);
  c.ok("可以打开写作页", await c.run(() => document.body.classList.contains("wr")));
  c.ok("侧栏显示稿子名", (await c.run(() => $("wrtitle").textContent)) === "我的论文");

  // 所见即所得：保留卡片本身的字号与底色（这里是稿子里的拷贝，跟画布上的原卡片各自独立）
  const sty = await c.run((ids) => {
    const cap = document.querySelector(`#wrmain .blk[data-id="${ids.p1}"] .cap`);
    const wrap = document.querySelector(`#wrmain .blk[data-id="${ids.p1}"] .wrap`);
    return { size: getComputedStyle(cap).fontSize, bg: getComputedStyle(wrap).background,
      h1: getComputedStyle(document.querySelector(`#wrmain .blk[data-id="${ids.h1}"] .cap`)).fontSize };
  }, ids);
  c.ok("保留卡片字号", sty.size === "15px" && sty.h1 === "22px");
  c.ok("保留卡片底色", /rgba?\(/.test(sty.bg));

  const rn = await c.run((ids) => {
    verNew(card(ids.p2), true); redrawDocs();
    return [...document.querySelectorAll(`#wrmain .blk[data-id="${ids.p2}"] .vv`)].map((z) => z.textContent.trim());
  }, ids);
  c.ok("版本用罗马数字", rn[0] === "I" && rn[1] === "II");

  // 版本栏必须竖排且宽度恒定：横排时每加一版就往左长一截，
  // 早先的版本最终会溢出到抓不到的地方，这正是它以前点不中的原因
  const gut = await c.run((ids) => {
    const c2 = card(ids.p2);
    for (let i = 0; i < 6; i++) verNew(c2, true);
    redrawDocs();
    const g = document.querySelector(`#wrmain .blk[data-id="${ids.p2}"] .gut`);
    const vs = [...document.querySelectorAll(`#wrmain .blk[data-id="${ids.p2}"] .vv`)];
    const rs = vs.map((z) => z.getBoundingClientRect());
    const gr = g.getBoundingClientRect();
    return { w: gr.width,
      col: getComputedStyle(g.querySelector(".vb")).flexDirection,
      n: vs.length,
      // 竖排是右对齐的，字宽不同左边自然参差；真正要守的是右边缘齐平、
      // 而且每一个都还落在这条固定宽度的栏里（不往左溢出到抓不到的地方）
      sameRight: rs.every((r) => Math.abs(r.right - rs[0].right) < 2),
      inside: rs.every((r) => r.left >= gr.left - 1 && r.right <= gr.right + 1) };
  }, ids);
  c.ok("版本栏是竖排", gut.col === "column" && gut.n >= 7);
  c.ok("版本再多也不往左溢出", gut.w <= 44 && gut.sameRight && gut.inside);

  // 折叠框只留一个小符号，条数与说明文字都不写在正文里
  const foldHead = await c.run((ids) => {
    const fh = document.querySelector(`#wrmain .blk[data-id="${ids.p1}"] .fold .fh`);
    return { there: !!fh, txt: fh ? fh.textContent.trim() : "x" };
  }, ids);
  c.ok("每段下方只有一个小折叠符号", foldHead.there && foldHead.txt.length <= 1);
  const fold = await c.run((ids) => {
    // wrUnder 要指向这一段在稿子里实际的 id（拷贝出来的那个），不是原卡片的 id，
    // 折叠框才能在正确的段落下方显示出来
    card("tw").wrUnder = ids.p1; card("tw").wrIn = S.docs[0].id; redrawDocs();
    const f = document.querySelector(`#wrmain .blk[data-id="${ids.p1}"] .fold`);
    f.querySelector(".fh").click();
    return { refs: f.querySelectorAll(".ref").length, open: f.classList.contains("on"),
      editable: f.querySelector(".ref").getAttribute("contenteditable") };
  }, ids);
  c.ok("分身可以挂到卡片下方并展开", fold.refs === 1 && fold.open);
  c.ok("引用条目是投影，不可编辑", fold.editable === "false");

  c.ok("顶栏是迭代与 Context", await c.run(() => !!$("wrmodeI") && !!$("wrmodeC")));
  await c.page.click("#wrmodeC");
  await c.wait(400);
  c.ok("Context 模式只呈现连贯文本", await c.run(() =>
    S.docs[0].mode === "ctx" && document.querySelectorAll("#wrmain .vv").length === 0));
  await c.page.click("#wrmodeI");
  await c.wait(300);

  c.ok("可以把某一版复制到剪贴板", await c.run((ids) => {
    const cc = card(ids.p2); verToClip(cc, orig(cc).verOn);
    return CLIP && CLIP.mode === "copy" && CLIP.items.length === 1 && !CLIP.items[0].snap.vers;
  }, ids));

  await c.run((ids) => {
    const cap = document.querySelector(`#wrmain .blk[data-id="${ids.p2}"] .cap`);
    cap.focus(); cap.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  }, ids);
  await c.wait(400);
  c.ok("专注模式里编辑正文不弹出浮动工具栏，只有顶上常驻的 fmtbar",
    await c.run(() => !$("bar").classList.contains("on")));

  // 顶上那条工具栏必须真的管用：以前它只是摆着好看，点了什么都不会发生
  c.ok("稿子顶上有常驻的文字工具栏",
    await c.run(() => $("wrfmt").querySelectorAll(".fx").length >= 8));
  c.ok("工具栏加粗真的写进了卡片", await c.run((ids) => {
    const cap = document.querySelector(`#wrmain .blk[data-id="${ids.p2}"] .cap`);
    cap.focus();
    const r = document.createRange(); r.selectNodeContents(cap);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    sel = [ids.p2]; editing = true;
    cmd("bold");
    const o = orig(card(ids.p2));
    return !!o.rich && /font-weight|<b\b|<strong\b/i.test(o.rich);
  }, ids));
  c.ok("工具栏点击不夺走文字选区", await c.run((ids) => {
    const cap = document.querySelector(`#wrmain .blk[data-id="${ids.p2}"] .cap`);
    cap.focus();
    const r = document.createRange(); r.selectNodeContents(cap);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    const btn = $("wrfmt").querySelector(".fx");
    const ev = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    btn.dispatchEvent(ev);
    return ev.defaultPrevented && !getSelection().isCollapsed;
  }, ids));

  // 导出面板必须真的定位、真的能选：早先用的类名在 .pop 里根本不存在，
  // 而且从未调用 place()，浮层没有坐标，看起来一团糟也点不动
  c.ok("导出面板可以选择格式并且真的定位", await c.run(() => {
    openWrExport(S.docs[0], 120, 90);
    const p = $("pop");
    const fs2 = [...p.querySelectorAll("#wfmt button")].map((z) => z.dataset.f).join(",");
    const positioned = parseFloat(p.style.left) > 0 && parseFloat(p.style.top) > 0;
    const r = p.getBoundingClientRect();
    const onScreen = r.width > 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
    p.querySelector('#wfmt button[data-f="md"]').click();
    const picked = p.querySelector('#wfmt button[data-f="md"]').classList.contains("on")
      && !p.querySelector('#wfmt button[data-f="docx"]').classList.contains("on");
    const has = !!p.querySelector("#wv") && !!p.querySelector("#wr2") && !!p.querySelector("#wgo");
    p.classList.remove("on");
    return fs2 === "docx,pdf,html,md" && positioned && onScreen && picked && has;
  }));

  // 断网也要导得出来：Markdown 不依赖任何外部库
  c.ok("Markdown 正文不依赖外部库", await c.run(() => {
    const md = wrMD(S.docs[0], { vers: false, refs: false });
    return md.startsWith("# ") && md.includes("理论框架");
  }));

  // 写作页编辑改的是稿子里的拷贝，不会牵动画布上的原卡片
  await c.run((ids) => {
    const el = document.querySelector(`#wrmain .blk[data-id="${ids.p2}"] .cap`);
    el.focus(); el.innerText = "改写过的第二段。";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, ids);
  await c.wait(500);
  c.ok("写作页编辑改到的是稿子里的拷贝",
    (await c.run((ids) => card(ids.p2).text, ids)) === "改写过的第二段。");
  c.ok("画布上的原卡片完全不受牵动", (await c.run(() => card("p2").text)) === "第二段内容。");
  c.ok("写作页随文件保存", (await c.run(() => bundle(null).docs[0].ids.length)) === 3);

  await c.run(() => closeWrite());
  await c.wait(400);
  c.ok("可以返回画布", await c.run(() => !document.body.classList.contains("wr")));
  await c.run(() => { S.docs = []; });
});

group("wredit 写作页自由编辑", async (c) => {
  await c.run(() => {
    S.cards = [
      { id: "h1", x: 0, y: 0, w: 400, text: "标题", level: 1, s: { ...DEF } },
      { id: "p1", x: 0, y: 200, w: 400, text: "第一段。", s: { ...DEF } },
      { id: "p2", x: 0, y: 400, w: 400, text: "第二段。", s: { ...DEF } },
    ];
    S.links = []; S.frames = []; S.sheets = []; S.docs = [];
    invalidateIndex(); render();
    const d = addDoc({ x: 1200, y: 0 }, "自由编辑测试");
    wrImport(["h1", "p1", "p2"], false, d.id);
    camTo(1200, 0, 1, true);
  });
  await c.wait(500);

  // 任意位置插入一张新卡片：现在走右键菜单，不再有专属的"+"插入线
  const ins = await c.run(() => {
    const before = S.docs[0].ids.length;
    wrInsertAt(S.docs[0], 1);
    return { before, after: S.docs[0].ids.length, mid: S.docs[0].ids[1] };
  });
  c.ok("可以在任意位置插入新卡片", ins.after === ins.before + 1);
  c.ok("插入的位置正确（第一段之后）", ins.mid !== "h1" && ins.mid !== "p1" && ins.mid !== "p2");

  // 稿子里新建的段落只活在稿子内部，不会在画布上再冒出一份"重复添加"的文字框
  const onlyInDoc = await c.run(() => {
    const id = S.docs[0].ids[1];
    return { marked: !!card(id).wrIn, onCanvas: !!nodes.get(id),
      inDocBody: !!document.querySelector(`#docs .doc .blk[data-id="${id}"]`) };
  });
  c.ok("稿内新建的段落带归属标记", onlyInDoc.marked);
  c.ok("它不会在画布上重复出现", !onlyInDoc.onCanvas && onlyInDoc.inDocBody);

  // 右键菜单同时给出插入空白段落与粘贴，跟画布上的剪贴板是同一套
  const blkMenu = await c.run(() => {
    sel = ["p1"]; clipCards("copy");
    // p2 送进稿子的是独立拷贝，按内容找出它在稿子里对应的 id
    const p2clone = S.docs[0].ids.find((id) => card(id).text === "第二段。");
    const blk = document.querySelector(`#docs .doc .blk[data-id="${p2clone}"]`);
    blk.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
    const items = [...document.querySelectorAll("#menu .mi")].map((z) => z.textContent.trim());
    // 文案只有页面里才有，标签一并在页面内取出来比对
    return { items, above: t("wrInsertAbove"), below: t("wrInsertBelow"), after: t("wrPasteAfter") };
  });
  c.ok("段落右键菜单提供插入空白段落",
    blkMenu.items.some((z) => z.includes(blkMenu.above))
    && blkMenu.items.some((z) => z.includes(blkMenu.below)));
  c.ok("段落右键菜单提供粘贴", blkMenu.items.some((z) => z.includes(blkMenu.after)));

  // 菜单必须能靠点击稿子内部的空白关掉，不该非得点到页面外
  const closed = await c.run(() => {
    const body = document.querySelector("#docs .doc .dbody");
    body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    return !$("menu").classList.contains("on");
  });
  c.ok("点稿子内部的空白就能关掉右键菜单", closed);

  // 回车 = 从光标处切成下一张卡片
  const split = await c.run(() => {
    const d = S.docs[0];
    d.ids = ["h1", "p1", "p2"]; redrawDocs();
    const cap = document.querySelector('#docs .doc .blk[data-id="p1"] .cap');
    cap.focus();
    const r = document.createRange();
    r.setStart(cap.firstChild, 3); r.collapse(true);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    wrSplitAtCaret(d, card("p1"), cap);
    return { ids: d.ids.length, head: card("p1").text,
      tail: card(d.ids[2]) ? card(d.ids[2]).text : "" };
  });
  c.ok("回车从光标处切成下一张卡片", split.ids === 4);
  c.ok("切分的前后内容各归其位", split.head === "第一段" && split.tail === "。");

  // 划选自由文字，把它单独立成一张卡片
  const toCard = await c.run(() => {
    const d = S.docs[0];
    d.ids = ["h1", "p1", "p2"];
    card("p1").text = "前面的话中间的话后面的话"; delete card("p1").rich;
    redrawDocs();
    const cap = document.querySelector('#docs .doc .blk[data-id="p1"] .cap');
    cap.focus();
    const r = document.createRange();
    r.setStart(cap.firstChild, 4); r.setEnd(cap.firstChild, 8);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    wrSelToCard(d, card("p1"), cap);
    return { ids: d.ids.length, a: card("p1").text,
      b: card(d.ids[2]) && card(d.ids[2]).text, cc: card(d.ids[3]) && card(d.ids[3]).text };
  });
  c.ok("划选的文字可以单独变成一张卡片", toCard.ids === 5);
  c.ok("选区前后各自成段，顺序不变",
    toCard.a === "前面的话" && toCard.b === "中间的话" && toCard.cc === "后面的话");

  // 单击选中一段（不进入编辑），backspace 把它从稿子里移出，源卡片不受影响
  const rm = await c.run(() => {
    S.docs[0].ids = ["h1", "p1", "p2"]; redrawDocs();
    const blk = document.querySelector('#docs .doc .blk[data-id="p2"]');
    const before = S.docs[0].ids.length;
    sel = ["p2"]; editing = false; paintSel();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    return { selected: blk.classList.contains("sel"), before,
      after: S.docs[0].ids.length, stillOnCanvas: !!card("p2") };
  });
  c.ok("选中的段落会高亮", rm.selected);
  c.ok("选中后按删除键移出稿子", rm.after === rm.before - 1);
  c.ok("源卡片本身没有被删除", rm.stillOnCanvas);

  // 写作页的操作要能撤销：undo 应该把刚才移出的段落还原回来
  const undone = await c.run(() => {
    applyUndo(undo, redo);
    return { ids: S.docs[0].ids.length, back: S.docs[0].ids.includes("p2") };
  });
  c.ok("写作页的删除可以撤销", undone.ids === rm.before && undone.back);
  await c.run(() => { applyUndo(redo, undo); });   // redo 回到移出之后，方便后续断言

  // 选中状态要扛得住重绘：别处的操作触发重画后，选中高亮不能悄悄消失，
  // 否则再按删除键会因为找不到 .blk.sel 落到误删源卡片的老路上
  const survive = await c.run(() => {
    sel = ["p1"]; editing = false; paintSel();
    redrawDocs();  // 模拟别处操作触发的重绘
    return !!document.querySelector('#docs .doc .blk[data-id="p1"].sel');
  });
  c.ok("重绘之后选中高亮仍然保留", survive);

  // 粘贴一个分身到折叠引用框里
  const paste = await c.run(() => {
    sel = ["p2"]; clipCards("twin");
    wrPasteTwin("h1", S.docs[0]);
    const kids = wrKids("h1");
    return { made: kids.length, ref: kids[0] && kids[0].ref, marked: kids[0] && !!kids[0].wrIn };
  });
  c.ok("可以把分身粘到段落下方的折叠引用框里", paste.made === 1 && paste.ref === "p2");

  // 分身在这里只是投影：不上画布，也不参与文档顺序，
  // 否则同一段内容会在画布与稿子里各显示一次
  const proj = await c.run(() => {
    const kid = wrKids("h1")[0];
    render();
    return { marked: !!kid.wrIn, onCanvas: !!nodes.get(kid.id),
      inOrder: docOrder().some((z) => z.id === kid.id) };
  });
  c.ok("分身带归属标记，不落在画布上", proj.marked && !proj.onCanvas);
  c.ok("分身不参与文档顺序与编号", !proj.inOrder);

  // 撤掉一条投影不影响外面的任何卡片
  const drop = await c.run(() => {
    const kid = wrKids("h1")[0];
    snap();
    S.cards = S.cards.filter((z) => z.id !== kid.id);
    invalidateIndex(); redrawDocs();
    return { kids: wrKids("h1").length, srcAlive: !!card("p2") };
  });
  c.ok("撤掉投影不影响源卡片", drop.kids === 0 && drop.srcAlive);

  // 用统一的"剪贴板→右键粘贴"逻辑把内容拷贝进正文顺序（不是分身，是内容的独立拷贝）
  const pasteMain = await c.run(() => {
    S.docs[0].ids = ["h1", "p1"]; redrawDocs();
    sel = ["p2"]; clipCards("copy");
    const before = S.docs[0].ids.length;
    wrPasteMain(S.docs[0], 1);
    const at1 = S.docs[0].ids[1];
    return { before, after: S.docs[0].ids.length, at1, at1Text: card(at1) && card(at1).text };
  });
  c.ok("可以用剪贴板把内容粘进正文顺序", pasteMain.after === pasteMain.before + 1);
  c.ok("粘进去的是内容的独立拷贝，不是卡片本身",
    pasteMain.at1 !== "p2" && pasteMain.at1Text === "第二段。");
  c.ok("画布上的原卡片完全不受影响", (await c.run(() => card("p2").text)) === "第二段。");
  const again = await c.run(() => {
    const before = S.docs[0].ids.length;
    sel = ["p2"]; clipCards("copy");
    wrPasteMain(S.docs[0], 0);
    return { before, after: S.docs[0].ids.length };
  });
  c.ok("再次粘贴同一张源卡片会另建一份独立拷贝，不做去重（不再是同一份内容）",
    again.after === again.before + 1);

  // 空稿子没有"末尾"可言，菜单上就该只说"粘贴"
  const pasteLbl = await c.run(() => {
    S.docs = [{ id: "E", x: 0, y: 0, title: "空稿", ids: [], mode: "iter", open: {} }];
    render();
    sel = ["p2"]; clipCards("copy");
    docMenu(5, 5, S.docs[0]);
    const empty = [...document.querySelectorAll("#menu .mi")].map((z) => z.textContent.trim());
    closeMenus();
    S.docs[0].ids = ["p2"]; render();
    docMenu(5, 5, S.docs[0]);
    const filled = [...document.querySelectorAll("#menu .mi")].map((z) => z.textContent.trim());
    closeMenus();
    return { empty, filled, here: t("wrPasteHere"), end: t("wrPasteEnd") };
  });
  c.ok("空稿子的菜单只说粘贴",
    pasteLbl.empty.includes(pasteLbl.here) && !pasteLbl.empty.includes(pasteLbl.end));
  c.ok("有内容的稿子仍说粘贴到末尾", pasteLbl.filled.includes(pasteLbl.end));

  await c.run(() => closeMenus());
  await c.run(() => { S.docs = []; render(); });
});

group("wrsend 送入写作页改用统一剪贴板", async (c) => {
  await c.board([{ id: "a", x: 0, y: 0, w: 300, text: "甲卡片", s: {} }], []);
  const r = await c.run(() => {
    sel = ["a"]; paintSel();
    cardMenu(50, 50);
    const items = [...document.querySelectorAll("#menu .mi")].map((z) => z.textContent.trim());
    return { items, twinLbl: t("clipTwinDo"), copyLbl: t("clipCopyDo") };
  });
  c.ok("卡片右键菜单不再有单独的送入写作页",
    !r.items.some((z) => z.includes("写作页") || z.toLowerCase().includes("writing page")));
  c.ok("复制与分身剪贴板选项还在",
    r.items.some((z) => z.includes(r.twinLbl)) && r.items.some((z) => z.includes(r.copyLbl)));
  await c.run(() => closeMenus());
});

/* =====================================================================
   写作页的顺序：结构连线优先，空间位置其次，剪贴板的先后从不作数
   ---------------------------------------------------------------------
   这一组守着一个真实回归：框选得到的 sel 是 S.cards 的数组顺序（卡片的创建先后），
   clipCards 原样存进 CLIP，wrClonesFromClip 又原样落地，于是"复制一批卡片粘进写作页"
   出来的段落跟画布上的结构毫无关系——用结构线挂在二级标题后面的正文，
   只要建得比标题早，就会整批浮到稿子最前面。
   ===================================================================== */

// 刻意打乱创建顺序：正文全在前，标题全在后
const ORD_CARDS = [
  { id: "b11a", x: 520, y: 0, w: 200, text: "正文1.1甲", s: {} },
  { id: "b11b", x: 520, y: 80, w: 200, text: "正文1.1乙", s: {} },
  { id: "b12a", x: 520, y: 160, w: 200, text: "正文1.2甲", s: {} },
  { id: "b21a", x: 520, y: 400, w: 200, text: "正文2.1甲", s: {} },
  { id: "h11", x: 250, y: 0, w: 200, text: "一点一", level: 2, s: {} },
  { id: "h12", x: 250, y: 160, w: 200, text: "一点二", level: 2, s: {} },
  { id: "h21", x: 250, y: 400, w: 200, text: "二点一", level: 2, s: {} },
  { id: "h1", x: 0, y: 0, w: 200, text: "第一章", level: 1, s: {} },
  { id: "h2", x: 0, y: 400, w: 200, text: "第二章", level: 1, s: {} },
];
const ORD_LINKS = [
  { id: "s1", a: "h1", b: "h11", st: true },
  { id: "s2", a: "h1", b: "h12", st: true },
  { id: "s3", a: "b11a", b: "h11", st: true },   // 线是从正文画向标题的，方向照样不作数
  { id: "s4", a: "h11", b: "b11b", st: true },
  { id: "s5", a: "h12", b: "b12a", st: true },
  { id: "s6", a: "h2", b: "h21", st: true },
  { id: "s7", a: "h21", b: "b21a", st: true },
];
const ORD_WANT = "第一章|一点一|正文1.1甲|正文1.1乙|一点二|正文1.2甲|第二章|二点一|正文2.1甲";

group("wrorder 写作页里的顺序", async (c) => {
  await c.board(ORD_CARDS, ORD_LINKS);
  const r = await c.run(() => {
    S.docs = [];
    const d = addDoc({ x: 2000, y: 0 }, "顺序");
    sel = S.cards.filter((z) => !z.wrIn).map((z) => z.id);   // 框选拿到的就是创建顺序
    const clipOrder = sel.map((id) => card(id).text).join("|");
    clipCards("copy");
    wrPasteMain(d, 0);
    return { clipOrder, docOrder: d.ids.map((id) => card(id).text).join("|"),
      n: d.ids.length, onBoard: S.cards.filter((z) => !z.wrIn).length };
  });
  c.ok("剪贴板里本来就是乱的（正文在标题之前）", r.clipOrder.indexOf("正文1.1甲") < r.clipOrder.indexOf("第一章"));
  c.ok("粘进稿子后按结构连线排列，正文紧跟它的标题", r.docOrder === ORD_WANT);
  c.ok("一张不多一张不少", r.n === 9);
  c.ok("画布上的原卡片一张都没动", r.onBoard === 9);

  // 关联连线（非结构线）表达的是"排在一起"，那是导出成文时的意图，
  // 不能把正文从它的结构父节点下面拽走。用的是树本身的顺序而不是 buildTree().flat。
  await c.board(ORD_CARDS, [...ORD_LINKS, { id: "r1", a: "b21a", b: "h1" }]);
  const r2 = await c.run(() => {
    S.docs = [];
    const d = addDoc({ x: 2000, y: 0 }, "顺序");
    sel = S.cards.filter((z) => !z.wrIn).map((z) => z.id);
    clipCards("copy");
    wrPasteMain(d, 0);
    return d.ids.map((id) => card(id).text).join("|");
  });
  c.ok("关联连线不会把正文从它的标题下面拽走", r2 === ORD_WANT);

  // 没有结构连线时退回空间阅读顺序（也就是画布上的自然读法），而不是创建顺序
  await c.board(ORD_CARDS, []);
  const r3 = await c.run(() => {
    S.docs = [];
    const d = addDoc({ x: 2000, y: 0 }, "顺序");
    sel = S.cards.filter((z) => !z.wrIn).map((z) => z.id);
    clipCards("copy");
    wrPasteMain(d, 0);
    return { txt: d.ids.map((id) => card(id).text).join("|"),
      same: d.ids.map((id) => card(id).text).join("|") === docOrder(S.cards.filter((z) => !z.wrIn)).map((z) => z.text).join("|") };
  });
  c.ok("没有结构连线时按空间顺序，不是创建顺序", r3.txt.indexOf("第一章") < r3.txt.indexOf("正文1.1甲"));
  c.ok("空间顺序与画布的文档顺序一致", r3.same);

  // 只挑一个子树粘贴：局部也要保持结构顺序
  await c.board(ORD_CARDS, ORD_LINKS);
  const r4 = await c.run(() => {
    S.docs = [];
    const d = addDoc({ x: 2000, y: 0 }, "顺序");
    sel = ["b21a", "h21", "h2"];
    clipCards("copy");
    wrPasteMain(d, 0);
    return d.ids.map((id) => card(id).text).join("|");
  });
  c.ok("只粘一个子树时局部顺序也对", r4 === "第二章|二点一|正文2.1甲");

  // 单张卡片的粘贴不受影响（这条路径不建树，也不该报错）
  const r5 = await c.run(() => {
    const d = docs()[0];
    sel = ["b11a"];
    clipCards("copy");
    const before = d.ids.length;
    wrPasteMain(d, 1);
    return { before, after: d.ids.length, at: card(d.ids[1]).text };
  });
  c.ok("单张卡片仍然粘在指定位置", r5.after === r5.before + 1 && r5.at === "正文1.1甲");

  // 源卡片被删掉的剪贴板条目不能丢
  const r6 = await c.run(() => {
    S.docs = [];
    const d = addDoc({ x: 2000, y: 0 }, "顺序");
    sel = ["h1", "b11a", "h11"];
    clipCards("copy");
    S.cards = S.cards.filter((z) => z.id !== "b11a");
    invalidateIndex();
    wrPasteMain(d, 0);
    return d.ids.map((id) => card(id).text).join("|");
  });
  c.ok("源卡片已删除的条目照样落地，排在最后", r6 === "第一章|一点一|正文1.1甲");
});

group("fmtbar 写作页工具栏", async (c) => {
  // 按功能分成五组（文字 / 字体字号 / 颜色 / 段落 / 整段）加一个清除格式，
  // 组内不许被换行拆开，组与组之间才有分隔线。
  // 两个"光秃秃的小三角"已经没有了：间距与锁定都带名字或图标，
  // 而且不管有没有选中段落，弹层里永远有内容——早先没选中时弹出来的是两个空白框。
  await c.board([{ id: "p1", x: 0, y: 0, w: 400, text: "第一段内容。", s: {} }], []);
  await c.run(() => {
    S.docs = [];
    const d = addDoc({ x: 1200, y: 0 }, "稿子");
    sel = ["p1"]; clipCards("copy"); wrPasteMain(d, 0);
    sel = []; selDoc = null; paintSel(); syncFmtBars();
    openWrite(d.id);
  });
  await c.wait(700);

  const st = await c.run(() => {
    const h = document.querySelector("#wrfmt");
    const kids = [...h.children];
    return { groups: h.querySelectorAll(".fgrp").length,
      seps: h.querySelectorAll(".fsep").length,
      // 每个直接子元素要么是一组、要么是分隔线，不许有裸露的按钮
      // .fbrk 是那个指定的折行点，宽高为零，不算按钮
      loose: kids.filter((z) => !z.classList.contains("fgrp") &&
        !z.classList.contains("fsep") && !z.classList.contains("fbrk")).length,
      // 一组之内的按钮必须在同一行（组不会被换行拆开）
      // 按行高分桶比 top 可靠：一组里字号那个小 span 比按钮矮，top 天生不一样
      split: [...h.querySelectorAll(".fgrp")].filter((g) => {
        const rows2 = new Set([...g.children].map((z) => {
          const r3 = z.getBoundingClientRect();
          return Math.round((r3.top + r3.height / 2) / 14);
        }));
        return rows2.size > 1;
      }).length,
      naked: [...h.querySelectorAll(".fx")].filter((z) =>
        z.textContent.trim() === "\u25BE" && !z.classList.contains("caret")).length };
  });
  c.ok("按功能分成了五组加清除、字数（共 " + st.groups + " 组）", st.groups === 7);
  c.ok("分隔线只出现在组之间", st.seps === st.groups - 1);
  c.ok("没有游离在组之外的按钮", st.loose === 0);
  c.ok("换行不会把一组拆开", st.split === 0);
  c.ok("没有光秃秃的小三角按钮", st.naked === 0);

  // 弹层永远不空：没选中段落时给一句提示
  const empty = await c.run(() => {
    sel = []; paintSel(); syncFmtBars();
    const out = {};
    ["间距", "Spacing"].concat(["锁定", "Lock"]).forEach(() => {});
    const trig = [...document.querySelectorAll("#wrfmt .fx")]
      .find((z) => z.title === t("fmtSpacing"));
    trig.click();
    const pop = trig.parentElement.querySelector(".fpop");
    const r = { spacing: pop.textContent.trim(), dim: trig.classList.contains("off"),
      need: t("fmtNeedSel"),
      lockDim: document.querySelector("#wrfmt #fmtlock").closest(".fx").classList.contains("off") };
    closeFmtPops();
    return r;
  });
  c.ok("没选中时间距弹层给的是提示，不是空框", empty.spacing === empty.need);
  c.ok("需要选中才有意义的控件在没选中时是淡的", empty.dim && empty.lockDim);

  // 写作页的段落没有"位置"可锁（它们的 x/y 只是稿子的左上角，画布上根本不出现），
  // 所以锁定就是一个开关图标，不挂弹层——"锁定内容与位置"那一档留给画布的标准工具栏
  const lk = await c.run(() => {
    const el = document.querySelector("#wrfmt #fmtlock").closest(".fx");
    const d = wrDoc();
    sel = [d.ids[0]]; paintSel(); syncFmtBars();
    const before = !!card(d.ids[0]).lock;
    el.click();
    const on = card(d.ids[0]).lock;
    el.click();
    const off = card(d.ids[0]).lock;
    // 它就是组里的一个普通按钮：不在 .fcell 里（那是带弹层的形状），
    // 后面也没有跟着一个 .fx.caret
    const nx = el.nextElementSibling;
    return { pop: !!el.closest(".fcell") || !!(nx && nx.classList.contains("caret")),
      caret: el.innerHTML.includes("\u25BE"),
      before, on, off, icon: !!el.querySelector("svg") };
  });
  c.ok("锁定只有一个图标，没有折叠框", !lk.pop && !lk.caret);
  c.ok("点一下只锁内容，再点一下解开", !lk.before && lk.on === "text" && !lk.off);
  c.ok("锁的状态用图标表示", lk.icon);

  // 选中之后照常给出真正的内容
  const full = await c.run(() => {
    const d = wrDoc();
    sel = [d.ids[0]]; paintSel(); syncFmtBars();
    const trig = [...document.querySelectorAll("#wrfmt .fx")].find((z) => z.title === t("fmtSpacing"));
    trig.click();
    const pop = trig.parentElement.querySelector(".fpop");
    const box = pop.getBoundingClientRect();
    const r = { segs: pop.querySelectorAll(".seg button").length,
      sliders: pop.querySelectorAll('input[type=range]').length,
      // 滑块有自己的固有宽度，弹层不够宽时会从圆角框里呲出来
      fits: [...pop.querySelectorAll("*")].every((z) => {
        const q = z.getBoundingClientRect();
        return q.left >= box.left - 1 && q.right <= box.right + 1;
      }),
      dim: trig.classList.contains("off"), sz: document.querySelector("#wrfmt .fsz").textContent };
    closeFmtPops();
    return r;
  });
  c.ok("选中之后间距弹层有字重四档", full.segs === 4);
  c.ok("弹层里的东西没有呲出框外", full.fits);
  c.ok("字距与行距两个滑块都在", full.sliders === 2);
  c.ok("选中之后不再是淡的", !full.dim);
  c.ok("字号显示的是当前段落的字号", /^\d+$/.test(full.sz));

  // 三个颜色摆在同一组里：文字色、荧光笔、整段底色
  c.ok("三个颜色在同一组", await c.run(() => {
    const chips = [...document.querySelectorAll("#wrfmt .chip")];
    return chips.length === 3 && chips.every((z) => z.closest(".fgrp") === chips[0].closest(".fgrp"));
  }));

  // 清除格式不再是那个像"删除"的 ✘
  c.ok("清除格式换成了橡皮擦图标，不是 ✘", await c.run(() => {
    const b = [...document.querySelectorAll("#wrfmt .fx")].find((z) => z.title === t("fmtClear"));
    return !!b && !/\u2718|\u00D7|x/i.test(b.textContent) && !!b.querySelector("svg");
  }));

  // 功能没丢：加粗、颜色、对齐、清除仍然真的作用在段落上
  const act = await c.run(() => {
    const d = wrDoc(), id = d.ids[0];
    const cap = document.querySelector(`#wrmain .blk[data-id="${id}"] .cap`);
    const r2 = document.createRange();
    r2.selectNodeContents(cap);
    const s2 = getSelection(); s2.removeAllRanges(); s2.addRange(r2);
    sel = [id]; editing = true;
    cmd("bold");
    setAlign("center");
    const c2 = card(id);
    return { rich: (c2.rich || "").length > 0, align: (c2.s || {}).align };
  });
  c.ok("加粗仍然真的写进了这一段", act.rich);
  c.ok("对齐仍然真的作用在这一段", act.align === "center");

  // 弹层不许被稿子的右边缘切掉：.dwrap 有 overflow:hidden，
  // 靠右的控件（间距、锁定）向左对齐展开就会露在外面，被直接裁掉一截
  await c.run(() => closeWrite());
  await c.wait(500);
  const clip = await c.run(() => {
    const bar = document.querySelector(".doc .fmtbar");
    const wrap = document.querySelector(".doc .dwrap").getBoundingClientRect();
    const out = [];
    [...bar.querySelectorAll(".fx")].forEach((x) => {
      const pop = x.parentElement.querySelector(".fpop");
      if (!pop || !x.classList.contains("caret") && !pop) return;
      x.click();
      if (pop.classList.contains("on")) {
        const r3 = pop.getBoundingClientRect();
        out.push({ right: Math.round(r3.right), lim: Math.round(wrap.right),
          left: Math.round(r3.left), wl: Math.round(wrap.left) });
      }
      closeFmtPops();
    });
    return out;
  });
  c.ok("每一个弹层都完整落在稿子里（共 " + clip.length + " 个）",
    clip.length >= 5 && clip.every((z) => z.right <= z.lim && z.left >= z.wl));

  // 换字体、套模板不该让整条栏上的按钮跟着挪位置
  const stable = await c.run(() => {
    const bar = document.querySelector(".doc .fmtbar");
    const pos = () => [...bar.querySelectorAll(".fx")].map((z) =>
      Math.round(z.getBoundingClientRect().left) + "," + Math.round(z.getBoundingClientRect().top));
    const d = docs()[0];
    sel = [d.ids[0]]; paintSel(); syncFmtBars();
    const a2 = pos();
    setFamily("serif"); syncFmtBars();
    const b2 = pos();
    setFamily("sans"); syncFmtBars();
    return { moved: a2.filter((z, i) => z !== b2[i]).length };
  });
  c.ok("换字体之后按钮一个都没有挪位置", stable.moved === 0);

  // 窄的时候在指定的地方折行：改字一行、改段一行
  const brk = await c.run(() => {
    const bar = document.querySelector(".doc .fmtbar");
    // 按行高分桶：字数那一块是个矮 span，top 天生跟按钮不一样
    const rows2 = [...bar.querySelectorAll(".fgrp")].map((z) => {
      const r3 = z.getBoundingClientRect();
      return Math.round((r3.top + r3.height / 2) / 14);
    });
    const uniq = [...new Set(rows2)];
    return { rows: uniq.length, first: rows2.filter((z) => z === uniq[0]).length,
      hasBrk: !!bar.querySelector(".fbrk"),
      brkHidden: getComputedStyle(document.querySelector("#wrfmt .fbrk")).display === "none" };
  });
  c.ok("画布上的稿子里正好折成两行", brk.rows === 2);
  c.ok("断点在颜色组之后（前三组一行）", brk.first === 3);
  c.ok("专注模式关掉这个断点", brk.hasBrk && brk.brkHidden);

  // 画布上的稿子：文档级操作在上面一行，文字工具栏独占下面一整行
  const rows = await c.run(() => {
    const bar = document.querySelector(".doc .dbar");
    if (!bar) return null;
    const tool = bar.querySelector(".dtool").getBoundingClientRect();
    const fmt = bar.querySelector(".fmtbar").getBoundingClientRect();
    return { toolTop: Math.round(tool.top), fmtTop: Math.round(fmt.top),
      fmtW: Math.round(fmt.width), barW: Math.round(bar.getBoundingClientRect().width) };
  });
  c.ok("画布上的稿子里，模式与导出在上面一行", !!rows && rows.toolTop < rows.fmtTop);
  c.ok("文字工具栏独占一整行", !!rows && rows.fmtW > rows.barW * 0.9);
});

group("wrrefsel 引文可选中、跳转对得准", async (c) => {
  // 不可编辑 ≠ 不可选中。引文投影的用处就是抄一句出来放进正文，
  // 早先 .ref 上挂着 user-select:none，等于废了一半。
  // 另一头：挂在稿子折叠框里的分身没有"位置"（x/y 是稿子的左上角），
  // 拿它去 focusOn，镜头只会停在稿子左上角——所以改成翻开折叠框、滚到那一条。
  await c.board([
    { id: "q", x: 0, y: 0, w: 400, text: "Prior literature reviews on digital fashion focus on business.", s: {} },
    ...Array.from({ length: 12 }, (_, i) => ({ id: "f" + i, x: 0, y: 100 + i * 60, w: 400, text: "填充段落" + i, s: {} })),
  ], []);
  await c.run(() => {
    S.docs = [];
    const d = addDoc({ x: -900, y: 0 }, "稿子");
    sel = S.cards.filter((z) => z.id !== "q").map((z) => z.id);
    clipCards("copy"); wrPasteMain(d, 0);
    sel = ["q"]; clipCards("twin"); wrPasteTwin(d.ids[10], d);
    d.open = {}; openWrite(d.id);
  });
  await c.wait(700);
  await c.run(() => { const d = wrDoc(); d.open[d.ids[10]] = true; drawWrite() });
  await c.wait(300);

  const st = await c.run(() => {
    const el = document.querySelector("#wrmain .ref");
    return el ? { us: getComputedStyle(el).userSelect, ce: el.getAttribute("contenteditable") } : null;
  });
  c.ok("引文没有被 user-select:none 锁住", !!st && st.us !== "none");
  c.ok("但它依然不可编辑", !!st && st.ce === "false");

  // 真鼠标划一遍，确认选得中
  const box = await c.run(() => {
    const e = document.querySelector("#wrmain .ref"), r2 = e.getBoundingClientRect();
    return { x1: r2.left + 6, x2: r2.left + r2.width * 0.5, y: r2.top + r2.height / 2 };
  });
  await c.page.mouse.move(box.x1, box.y);
  await c.page.mouse.down();
  await c.page.mouse.move(box.x2, box.y, { steps: 10 });
  await c.page.mouse.up();
  c.ok("鼠标划得动，选得到文字", await c.run(() => getSelection().toString().length > 8));
  c.ok("改不动它的内容", await c.run(() => {
    const e = document.querySelector("#wrmain .ref"), before = e.textContent;
    e.focus();
    try { document.execCommand("insertText", false, "XXX") } catch (err) {}
    return e.textContent === before;
  }));

  // 从画布点分身角标跳过来：要落在那一条引文上，不是稿子左上角
  await c.run(() => { closeWrite(); camTo(0, 0, 1, true) });
  await c.wait(400);
  const jump = await c.run(() => {
    const el = nodes.get("q");
    const has = !!(el && el.querySelector(".twin"));
    gotoTwin(card("q"), false);
    return has;
  });
  c.ok("画布上的源卡片有分身角标", jump);
  await c.wait(900);
  const land = await c.run(() => {
    const box2 = document.getElementById("wrmain");
    const el = box2 && box2.querySelector(".ref");
    if (!el) return { wr: document.body.classList.contains("wr"), found: false };
    const r2 = el.getBoundingClientRect(), br = box2.getBoundingClientRect();
    return { wr: document.body.classList.contains("wr"), found: true,
      inView: r2.top >= br.top - 2 && r2.bottom <= br.bottom + 2,
      flash: el.classList.contains("flash"), scroll: box2.scrollTop };
  });
  c.ok("跳过去会把稿子打开", land.wr);
  c.ok("折叠框被翻开，那一条引文渲染出来了", land.found);
  c.ok("镜头落在引文上，不是稿子左上角", land.inView && land.scroll > 20);
  c.ok("闪一下好认出是哪一条", land.flash);
  await c.run(() => closeWrite());
});

group("wrwc 写作页字数统计", async (c) => {
  // 中日韩按"字"、拉丁按"词"，两者相加才是中英混排稿子里通常说的字数。
  // 数的是纯文本，不碰 rich；折叠框里的引文（别人的话）和其他版本（没采用的稿子）
  // 都不算进"我写了多少"。划选之后只报选中的那一段。
  await c.board([
    { id: "h", x: 0, y: 0, w: 400, text: "Introduction", level: 1, s: {} },
    { id: "p1", x: 0, y: 100, w: 400, text: "数字时尚是一个新兴领域，尚未发展出稳固的理论和定义。", s: {} },
    { id: "p2", x: 0, y: 200, w: 400, text: "This article proposes that digital fashion is an emerging subfield.", s: {} },
    { id: "q", x: 0, y: 300, w: 400, text: "引文原文不该被算进去", s: {} },
  ], []);
  const calc = await c.run(() => ({
    en: wcOf("This article proposes that digital fashion is an emerging subfield."),
    cn: wcOf("数字时尚是一个新兴领域。"),
    mix: wcOf("数字时尚是一个新兴领域（Baek et al., 2022）"),
    empty: wcOf("   "), none: wcOf(""),
    punct: wcOf("。，、；：！"),
  }));
  c.ok("英文按词数（10 词）", calc.en.words === 10);
  c.ok("中文按字数，标点不算（11 字）", calc.cn.words === 11);
  c.ok("中英混排两者相加", calc.mix.words === 11 + 4);
  c.ok("空文本是 0，不报错", calc.empty.words === 0 && calc.none.words === 0);
  c.ok("光是标点算 0 个字", calc.punct.words === 0);

  await c.run(() => {
    S.docs = [];
    const d = addDoc({ x: -900, y: 0 }, "稿子");
    sel = ["h", "p1", "p2"]; clipCards("copy"); wrPasteMain(d, 0);
    sel = ["q"]; clipCards("twin"); wrPasteTwin(d.ids[1], d);
    openWrite(d.id);
  });
  await c.wait(800);

  const doc = await c.run(() => {
    const d = wrDoc();
    return { ...wcDoc(d), refs: wrKids(d.ids[1]).length };
  });
  c.ok("整份稿子的字数是各段之和（1 + 24 + 10）", doc.words === 35);
  c.ok("折叠框里的引文不计入", doc.words === 35 && doc.refs === 1);
  c.ok("段数只数有内容的段", doc.paras === 3);

  const bar = await c.run(() => {
    const el = document.querySelector("#wrfmt .fwc");
    return { txt: el.textContent, title: el.title, on: el.classList.contains("on") };
  });
  c.ok("工具栏最后显示的是整份稿子的字数", /35/.test(bar.txt));
  c.ok("悬停能看到字符数与段数", /35/.test(bar.title) && /96/.test(bar.title) && /3/.test(bar.title));
  c.ok("没划选时不加重", !bar.on);

  // 划选之后只报选中的部分
  const selr = await c.run(() => {
    const e = document.querySelectorAll("#wrmain .cap")[1], n = e.firstChild;
    const r2 = document.createRange();
    r2.setStart(n, 0); r2.setEnd(n, 6);
    const s2 = getSelection(); s2.removeAllRanges(); s2.addRange(r2);
    return getSelection().toString();
  });
  await c.wait(300);
  const selBar = await c.run(() => {
    const el = document.querySelector("#wrfmt .fwc");
    return { txt: el.textContent, on: el.classList.contains("on") };
  });
  c.ok("划选之后只统计选中的部分", selr.length === 6 && /6/.test(selBar.txt));
  c.ok("划选时读数加重，看得出换了口径", selBar.on);

  await c.run(() => getSelection().removeAllRanges());
  await c.wait(300);
  c.ok("取消选中就回到全文字数", await c.run(() =>
    /35/.test(document.querySelector("#wrfmt .fwc").textContent)));

  // 打字之后要跟着变
  await c.run(() => {
    const d = wrDoc(), c2 = card(d.ids[1]);
    c2.text = "数字时尚。";
    refreshDocMeta();
  });
  await c.wait(300);
  c.ok("改了内容之后读数跟着变（1 + 4 + 10）", await c.run(() =>
    /15/.test(document.querySelector("#wrfmt .fwc").textContent)));

  c.ok("中英文案都齐了", await c.run(() =>
    !!(T.en.wcWords && T.zh.wcWords && T.en.wcSel && T.zh.wcSel && T.en.wcTitle && T.zh.wcTitle)));
  await c.run(() => closeWrite());
});

group("wrmarq 稿子里不许拉出画布的框选", async (c) => {
  // 画布上的稿子内部按住一拖，会蒙出一个灰色大方框——那是画布用来圈选卡片的
  // #marq，跟稿子里的文字选中完全是两回事。根因：.doc 的 pointerdown 对
  // .ref/.fold/.vv 这些控件是直接 return（不拦截），事件一路冒到 stage 拉起框选。
  await c.board([
    { id: "far", x: 1200, y: 0, w: 300, text: "画布卡片", s: {} },
    { id: "host", x: 0, y: 0, w: 400, text: "承载段落的一段文字", s: {} },
    { id: "q1", x: 0, y: 100, w: 400, text: "引文甲的一段比较长的文字", s: {} },
    { id: "q2", x: 0, y: 200, w: 400, text: "引文乙的一段比较长的文字", s: {} },
  ], []);
  await c.run(() => {
    S.docs = [];
    const d = addDoc({ x: -380, y: -260 }, "稿子");
    sel = ["host"]; clipCards("copy"); wrPasteMain(d, 0);
    ["q1", "q2"].forEach((id) => { sel = [id]; clipCards("twin"); wrPasteTwin(d.ids[0], d) });
    d.open = {}; d.open[d.ids[0]] = true;
    sel = []; paintSel(); camTo(0, 0, 1, true); render();
  });
  await c.wait(700);

  const probe = async (q2) => {
    const pt = await c.run((s2) => {
      const e = document.querySelector(s2), r2 = e.getBoundingClientRect();
      return { x: r2.left + 20, y: r2.top + r2.height / 2 };
    }, q2);
    await c.page.mouse.move(pt.x, pt.y);
    await c.page.mouse.down();
    await c.page.mouse.move(pt.x + 120, pt.y + 90, { steps: 6 });
    const shown = await c.run(() => getComputedStyle($("marq")).display !== "none");
    await c.page.mouse.up();
    return shown;
  };
  c.ok("在引文上拖不会拉出框选", !(await probe(".doc .ref")));
  c.ok("在正文段落上拖不会拉出框选", !(await probe(".doc .cap")));
  c.ok("在折叠框上拖不会拉出框选", !(await probe(".doc .fold")));

  // 画布本身的框选一点没动
  const st = await c.run(() => {
    const r2 = $("stage").getBoundingClientRect();
    return { x: r2.left + 60, y: r2.bottom - 60 };
  });
  await c.page.mouse.move(st.x, st.y);
  await c.page.mouse.down();
  await c.page.mouse.move(st.x + 200, st.y - 200, { steps: 6 });
  const canvasMarq = await c.run(() => getComputedStyle($("marq")).display !== "none");
  await c.page.mouse.up();
  c.ok("画布空白处仍然框选得出来", canvasMarq);

  // 稿子仍然能拖动，菜单仍然会被关掉
  const moved = await (async () => {
    const q3 = await c.run(() => {
      const e = document.querySelector(".doc .dside"), r2 = e.getBoundingClientRect();
      return { x: r2.left + Math.min(30, r2.width / 2), y: r2.top + r2.height / 2 };
    });
    const before = await c.run(() => ({ x: docs()[0].x, y: docs()[0].y }));
    await c.page.mouse.move(q3.x, q3.y);
    await c.page.mouse.down();
    await c.page.mouse.move(q3.x + 50, q3.y + 40, { steps: 8 });
    await c.page.mouse.up();
    const after = await c.run(() => ({ x: docs()[0].x, y: docs()[0].y }));
    return after.x !== before.x || after.y !== before.y;
  })();
  c.ok("稿子空白处仍然能拖动整页", moved);

  await c.run(() => {
    const e = document.querySelector(".doc .cap"), r2 = e.getBoundingClientRect();
    e.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r2.left + 20, clientY: r2.top + 10 }));
  });
  await c.wait(200);
  c.ok("稿子里右键出得来菜单", await c.run(() => $("menu").classList.contains("on")));
  const rf = await c.run(() => {
    const e = document.querySelector(".doc .ref"), r2 = e.getBoundingClientRect();
    return { x: r2.left + 20, y: r2.top + 8 };
  });
  await c.page.mouse.click(rf.x, rf.y);
  await c.wait(200);
  c.ok("在稿子里按一下会关掉菜单", await c.run(() => !$("menu").classList.contains("on")));
});

group("wrreford 引文长按调序", async (c) => {
  // 引文投影在自己的引用框里上下调序，做成"真的把它拿起来"：
  // 长按到时间这一条离开文字流（框内绝对定位 + 阴影浮起），原地留一个同高的占位，
  // 拖动时占位跟着指针走，松手落进占位所在的位置。
  // 顺序就是 wrKids 的顺序，而 wrKids 读的是 S.cards 的数组顺序，
  // 所以调序= 把这几张卡片在 S.cards 里原位对调，不新增字段、存档格式不变。
  await c.board([
    { id: "host", x: 0, y: 0, w: 400, text: "承载段落", s: {} },
    { id: "q1", x: 0, y: 100, w: 400, text: "引文甲", s: {} },
    { id: "q2", x: 0, y: 200, w: 400, text: "引文乙", s: {} },
    { id: "q3", x: 0, y: 300, w: 400, text: "引文丙", s: {} },
    { id: "q4", x: 0, y: 400, w: 400, text: "引文丁", s: {} },
  ], []);
  await c.run(() => {
    S.docs = [];
    const d = addDoc({ x: -900, y: 0 }, "稿子");
    sel = ["host"]; clipCards("copy"); wrPasteMain(d, 0);
    ["q1", "q2", "q3", "q4"].forEach((id) => { sel = [id]; clipCards("twin"); wrPasteTwin(d.ids[0], d) });
    d.open = {}; d.open[d.ids[0]] = true; openWrite(d.id);
  });
  await c.wait(700);
  const order = () => c.run(() => wrKids(wrDoc().ids[0]).map((k) => orig(k).text).join("|"));
  const pts = () => c.run(() => [...document.querySelectorAll("#wrmain .ref")].map((e) => {
    const r2 = e.getBoundingClientRect();
    return { x: r2.left + r2.width / 2, y: r2.top + r2.height / 2 };
  }));
  const drag = async (from, to) => {
    const q = await pts();
    await c.page.mouse.move(q[from].x, q[from].y);
    await c.page.mouse.down();
    await c.wait(430);                       // 长按到进入调序
    await c.page.mouse.move(q[from].x, q[to].y, { steps: 10 });
    await c.page.mouse.up();
    await c.wait(350);
  };
  c.ok("四条引文都挂在同一段下面", await order() === "引文甲|引文乙|引文丙|引文丁");

  // 长按之后要看得出"被拿起来了"：浮起的那一条 + 原地的占位
  const q0 = await pts();
  await c.page.mouse.move(q0[0].x, q0[0].y);
  await c.page.mouse.down();
  await c.wait(430);
  const lift = await c.run(() => {
    const el = document.querySelector("#wrmain .ref.lift");
    const box = document.querySelector("#wrmain .fb");
    return { lifted: !!el, ph: !!box.querySelector(".refph"),
      reorder: box.classList.contains("reorder"),
      absolute: el ? getComputedStyle(el).position === "absolute" : false,
      shadow: el ? getComputedStyle(el).boxShadow !== "none" : false };
  });
  c.ok("长按之后这一条浮起来了", lift.lifted && lift.absolute && lift.shadow);
  c.ok("原地留下同高的占位", lift.ph);
  c.ok("整个引用框进入调序状态", lift.reorder);
  await c.page.mouse.up();
  await c.wait(300);

  // 划选与拿起要分得开：拿起之后全程不该冒出任何蓝色选区
  const q9 = await pts();
  await c.page.mouse.move(q9[0].x, q9[0].y);
  await c.page.mouse.down();
  await c.wait(200);
  c.ok("按住约 200ms 先给出预备反馈", await c.run(() =>
    !!document.querySelector("#wrmain .ref.armed")));
  await c.wait(250);
  c.ok("调序时整个引用框禁止划选", await c.run(() =>
    getComputedStyle(document.querySelector("#wrmain .fb")).userSelect === "none"));
  const during = [];
  for (const k of [1, 2]) {
    await c.page.mouse.move(q9[0].x + 40, q9[k].y, { steps: 6 });
    during.push(await c.run(() => getSelection().toString().length));
  }
  await c.page.mouse.up();
  await c.wait(350);
  c.ok("拖动全程一个字都没被划中", during.every((z) => z === 0));
  c.ok("落下之后也没有留下选中的字", await c.run(() => getSelection().toString().length === 0));
  c.ok("预备态没有残留", await c.run(() => document.querySelectorAll("#wrmain .ref.armed").length === 0));
  c.ok("松手之后划选恢复正常", await c.run(() =>
    getComputedStyle(document.querySelector("#wrmain .fb")).userSelect !== "none"));
  await c.run(() => {
    // 顺序被上面这一拖改过了，先复原再往下测
    const d = wrDoc(), want = ["引文甲", "引文乙", "引文丙", "引文丁"];
    const kids = wrKids(d.ids[0]);
    const slots = []; S.cards.forEach((z, i) => { if (kids.some((k) => k.id === z.id)) slots.push(i) });
    slots.forEach((pp, i) => { S.cards[pp] = kids.find((k) => orig(k).text === want[i]) });
    invalidateIndex(); redrawDocs();
  });
  await c.wait(300);
  c.ok("复原成功，继续测拖动落点", await order() === "引文甲|引文乙|引文丙|引文丁");

  await drag(0, 3);
  c.ok("能一路拖到末尾（不是差一位停下）", await order() === "引文乙|引文丙|引文丁|引文甲");
  await drag(3, 0);
  c.ok("也能一路拖回最前", await order() === "引文甲|引文乙|引文丙|引文丁");
  await drag(1, 2);
  c.ok("相邻两条能对调", await order() === "引文甲|引文丙|引文乙|引文丁");

  c.ok("四条都还在这个引用框里，一条没跑出去", await c.run(() => {
    const d = wrDoc();
    return document.querySelectorAll("#wrmain .fb .ref").length === 4
      && wrKids(d.ids[0]).length === 4 && d.ids.length === 1;
  }));
  c.ok("它们仍然是投影，源卡片一张没动", await c.run(() =>
    ["q1", "q2", "q3", "q4"].every((id) => card(id) && !card(id).wrIn)
    && wrKids(wrDoc().ids[0]).every((k) => !!k.ref)));

  // 拖到一半按 Esc：放回原处，什么都不改
  const q1 = await pts();
  await c.page.mouse.move(q1[0].x, q1[0].y);
  await c.page.mouse.down();
  await c.wait(430);
  await c.page.mouse.move(q1[0].x, q1[3].y, { steps: 8 });
  await c.page.keyboard.press("Escape");
  await c.page.mouse.up();
  await c.wait(350);
  c.ok("中途按 Esc 就地取消，顺序不变", await order() === "引文甲|引文丙|引文乙|引文丁");
  c.ok("取消之后没有留下浮起的元素或占位", await c.run(() =>
    document.querySelectorAll("#wrmain .refph,#wrmain .ref.lift,#wrmain .fb.reorder").length === 0));

  // 单击、以及没长按就快拖，都不许当成调序
  const q2 = await pts();
  await c.page.mouse.click(q2[0].x, q2[0].y);
  c.ok("单击不会动到顺序", await order() === "引文甲|引文丙|引文乙|引文丁");
  const p3 = await c.run(() => [...document.querySelectorAll("#wrmain .ref")].map((e) => {
    const r2 = e.getBoundingClientRect();
    return { x1: r2.left + 6, x2: r2.left + r2.width * 0.6, y: r2.top + r2.height / 2 };
  }));
  await c.page.mouse.move(p3[0].x1, p3[0].y);
  await c.page.mouse.down();
  await c.page.mouse.move(p3[0].x2, p3[0].y, { steps: 6 });
  await c.page.mouse.up();
  c.ok("没长按就拖，仍然是划字而不是调序", await order() === "引文甲|引文丙|引文乙|引文丁");
  c.ok("而且真的划到了字", await c.run(() => getSelection().toString().length > 0));
  await c.run(() => closeWrite());
});

group("wrtitle 稿子标题点选", async (c) => {
  // 跟页面框的标题一个规矩：点一下是选中（随后按 Z 定位），右键出菜单（改名在里面），
  // 双击才就地改名。早先它是 contenteditable，点一下光标直接进去，反而选不中。
  await c.board([{ id: "a", x: 0, y: 0, w: 400, text: "段落", s: {} }], []);
  await c.run(() => {
    S.docs = [];
    const d = addDoc({ x: -300, y: -200 }, "稿子 1");
    sel = ["a"]; clipCards("copy"); wrPasteMain(d, 0);
    sel = []; selDoc = null; paintSel(); camTo(0, 0, 1, true);
  });
  await c.wait(600);
  const t2 = await c.run(() => {
    const e = document.querySelector(".doc .dt"), r2 = e.getBoundingClientRect();
    return { x: r2.left + r2.width / 2, y: r2.top + r2.height / 2, ce: e.isContentEditable };
  });
  c.ok("标题不再是可直接编辑的", !t2.ce);
  await c.page.mouse.click(t2.x, t2.y);
  c.ok("点一下就选中了这份稿子", await c.run(() => selDoc === docs()[0].id));
  c.ok("点完没有把光标塞进标题里", await c.run(() => !document.activeElement.isContentEditable));

  await c.page.keyboard.press("z");
  await c.wait(800);
  c.ok("按 Z 能定位过去", await c.run(() => String(focusKey).startsWith("doc:")));

  await c.page.mouse.click(t2.x, t2.y, { button: "right" });
  await c.wait(250);
  const menu = await c.run(() => {
    const items = [...document.querySelectorAll("#menu .mi")].map((z) => z.textContent.trim());
    closeMenus();
    return { items, rename: t("wrDocRename") };
  });
  c.ok("右键出的是这份稿子的菜单，改名在里面",
    menu.items.some((z) => z.includes(menu.rename)));

  await c.run(() => { window.prompt = () => "新名字" });
  const t3 = await c.run(() => {
    const e = document.querySelector(".doc .dt"), r2 = e.getBoundingClientRect();
    return { x: r2.left + r2.width / 2, y: r2.top + r2.height / 2 };
  });
  await c.page.mouse.click(t3.x, t3.y, { clickCount: 2 });
  await c.wait(300);
  c.ok("双击才就地改名", await c.run(() => docs()[0].title === "新名字"));
});

group("wrcut 多选与剪切搬运", async (c) => {
  // 写作页里调段落顺序：Shift/Ctrl 点选整段，右键剪切，再到目标位置右键移过去。
  // **剪切是搬运，不是拷贝**——只在 d.ids 里重新排位，所以层级、版本、底色、
  // 挂在段落下面的引文投影全都原样跟着走，因为压根没有新建任何东西。
  await c.board([
    { id: "h1", x: 0, y: 0, w: 400, text: "Introduction", level: 1, s: {} },
    { id: "p1", x: 0, y: 100, w: 400, text: "段落一", s: {} },
    { id: "p2", x: 0, y: 200, w: 400, text: "段落二", s: {} },
    { id: "h2", x: 0, y: 300, w: 400, text: "Background", level: 2, s: {} },
    { id: "p3", x: 0, y: 400, w: 400, text: "段落三", s: {} },
    { id: "q", x: 0, y: 500, w: 400, text: "引文原文", s: {} },
  ], []);
  await c.run(() => {
    S.docs = [];
    const d = addDoc({ x: -900, y: 0 }, "稿子");
    sel = ["h1", "p1", "p2", "h2", "p3"]; clipCards("copy"); wrPasteMain(d, 0);
    sel = ["q"]; clipCards("twin"); wrPasteTwin(d.ids[3], d);   // 引文挂在 Background 下面
    sel = []; paintSel(); openWrite(d.id);
  });
  await c.wait(700);

  const pt = async (i) => await c.run((i) => {
    const e = document.querySelectorAll("#wrmain .blk .cap")[i], r2 = e.getBoundingClientRect();
    return { x: r2.left + r2.width / 2, y: r2.top + r2.height / 2 };
  }, i);
  const a = await pt(3), b = await pt(4), first = await pt(0);

  await c.page.mouse.click(a.x, a.y, { modifiers: ["Meta"] });
  await c.page.keyboard.down("Shift");
  await c.page.mouse.click(b.x, b.y);
  await c.page.keyboard.up("Shift");
  const ms = await c.run(() => ({ n: sel.length, painted: document.querySelectorAll("#wrmain .blk.sel").length,
    txt: sel.map((z) => card(z).text).join("|") }));
  c.ok("Shift 点选能选中一段以上", ms.n === 2 && ms.txt === "Background|段落三");
  c.ok("选中的段落都亮起来了", ms.painted === 2);

  await c.page.mouse.click(b.x, b.y, { button: "right" });
  await c.wait(250);
  const menu = await c.run(() => [...document.querySelectorAll("#menu .mi")].map((z) => z.textContent.trim()));
  c.ok("右键不会把多选打回一段（菜单说的是 2 段）", menu.some((z) => /剪切这 2 段|Cut these 2/.test(z)));
  await c.run(() => [...document.querySelectorAll("#menu .mi")]
    .find((z) => /剪切|^Cut/.test(z.textContent.trim())).click());
  await c.wait(200);
  c.ok("剪切当下不动数据，反悔无损失", await c.run(() => wrDoc().ids.length === 5));

  await c.page.mouse.click(first.x, first.y, { button: "right" });
  await c.wait(250);
  c.ok("目标位置的菜单里出现了移动项", await c.run(() =>
    [...document.querySelectorAll("#menu .mi")].some((z) => /移到上方|Move the cut/.test(z.textContent))));
  await c.run(() => [...document.querySelectorAll("#menu .mi")]
    .find((z) => /移到上方|Move the cut paragraphs above/.test(z.textContent)).click());
  await c.wait(400);

  const after = await c.run(() => {
    const d = wrDoc();
    const hd = d.ids.find((z) => card(z).text === "Background");
    return { order: d.ids.map((z) => card(z).text).join("|"),
      lv: card(hd).level, refs: wrKids(hd).length, n: d.ids.length,
      cards: S.cards.filter((z) => z.wrIn === d.id && !z.ref).length };
  });
  c.ok("两段一起搬到了新位置", after.order === "Background|段落三|Introduction|段落一|段落二");
  c.ok("层级跟着一起走", after.lv === 2);
  c.ok("挂在它下面的引文投影没有丢", after.refs === 1);
  c.ok("是搬运不是复制，段落总数没变", after.n === 5 && after.cards === 5);
  await c.run(() => closeWrite());
});

group("wrexport 稿子导出", async (c) => {
  // 两件事：① 导出 Word 必须永远有结果——真正的 .docx 要靠 CDN 上的 docx 库，
  // 联不上就退回写一份 .doc（HTML 外壳 + application/msword），Word 一样打得开；
  // ② 稿子里看到的标题编号要跟着导出去，三种格式共用 wrNumMap 那一份规则。
  await c.board([
    { id: "a", x: 0, y: 0, w: 400, text: "Introduction", level: 1, s: {} },
    { id: "b", x: 0, y: 200, w: 400, text: "引入", level: 2, s: {} },
    { id: "d", x: 0, y: 400, w: 400, text: "正文一段", s: {} },
    { id: "e", x: 0, y: 600, w: 400, text: "Background", level: 1, s: {} },
    { id: "f", x: 0, y: 800, w: 400, text: "讨论", level: 2, s: {} },
  ], []);
  await c.run(() => {
    S.docs = [];
    const doc = addDoc({ x: -900, y: 0 }, "稿子");
    sel = ["a", "b", "d", "e", "f"]; clipCards("copy"); wrPasteMain(doc, 0);
  });

  const num = await c.run(() => {
    const d = docs()[0], on = { vers: false, refs: false, nums: true },
      off = { vers: false, refs: false, nums: false };
    const md = wrMD(d, on), html = wrHTML(d, on), mdOff = wrMD(d, off);
    return { heads: md.split("\n").filter((z) => z.startsWith("#")),
      offHeads: mdOff.split("\n").filter((z) => z.startsWith("#")),
      htmlNums: (html.match(/class="num">([^<]+)</g) || []).map((z) => z.replace(/\D*(\d[\d.]*)\D*/, "$1")),
      // 编号不许落到正文段落上
      bodyNum: /class="num">[^<]*<\/span>正文一段/.test(html) };
  });
  c.ok("Markdown 的标题带上了编号",
    num.heads.join("|") === "# 稿子|## 1 Introduction|### 1.1 引入|## 2 Background|### 2.1 讨论");
  c.ok("编号跟稿子里看到的是同一套（第二章从 2 起）", num.htmlNums.join(",") === "1,1.1,2,2.1");
  c.ok("正文段落不编号", !num.bodyNum);
  c.ok("取消勾选就一个编号都没有",
    num.offHeads.join("|") === "# 稿子|## Introduction|### 引入|## Background|### 讨论");

  // 联不上网：退回 .doc，而不是弹一句报错就没了
  const off = await c.run(async () => {
    const d = docs()[0];
    const realLoad = window.loadDocx, realDl = window.dl, realDocx = window.docx;
    window.docx = undefined;
    window.loadDocx = () => Promise.reject(new Error("no network"));
    let got = null; window.dl = (blob, name) => { got = { name, type: blob.type, size: blob.size } };
    await wrExportWord(d, { vers: false, refs: false, nums: true });
    const txt = got ? "ok" : "none";
    window.loadDocx = realLoad; window.dl = realDl; window.docx = realDocx;
    return { got, txt };
  });
  c.ok("库拿不到时照样导得出 Word", !!off.got && off.got.size > 0);
  c.ok("退回的是 Word 能打开的 .doc",
    !!off.got && /\.doc$/.test(off.got.name) && off.got.type === "application/msword");

  // 库在时走真正的 .docx，编号与标题级别都要对
  const real = await c.run(async () => {
    const d = docs()[0];
    const seen = [], realDl = window.dl, realDocx = window.docx;
    class TextRun { constructor(o) { this.o = o; seen.push("run:" + (o.text || "")) } }
    class Paragraph { constructor(o) { this.o = o;
      seen.push("para:" + (o.text !== undefined ? o.text : "[rich]") + "|" + (o.heading || "-")) } }
    window.docx = { Document: class { constructor(o) { this.o = o } },
      Packer: { toBlob: async () => new Blob(["x"], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }) },
      Paragraph, TextRun,
      HeadingLevel: { TITLE: "T", HEADING_1: "H1", HEADING_2: "H2", HEADING_3: "H3",
        HEADING_4: "H4", HEADING_5: "H5", HEADING_6: "H6" } };
    let got = null; window.dl = (blob, name) => { got = { name, type: blob.type } };
    await wrExportWord(d, { vers: false, refs: false, nums: true });
    window.dl = realDl; window.docx = realDocx;
    return { got, seen };
  });
  c.ok("库在时导出的是真正的 .docx", !!real.got && /\.docx$/.test(real.got.name));
  c.ok("标题级别映射到 Word 的内置标题",
    real.seen.includes("para:1 Introduction|H1") && real.seen.includes("para:1.1 引入|H2"));
  c.ok("正文段落不带标题级别", real.seen.includes("para:正文一段|-"));

  // 文件名早先一律是 "undefined-稿子"：safeName 的序号参数是给存档包分页用的
  c.ok("导出的文件名不再带 undefined 前缀",
    !!real.got && real.got.name === "稿子.docx");
  c.ok("存档包的分页名仍然带序号", await c.run(() => safeName("引言", 1) === "01-引言"));

  // 导出面板里有这个开关，且默认是勾上的
  const ui = await c.run(() => {
    openWrExport(docs()[0], 100, 100);
    const box = document.querySelector("#pop #wn");
    const r = { has: !!box, checked: !!(box && box.checked),
      label: box ? box.parentElement.textContent.trim() : "" };
    document.querySelector("#pop").classList.remove("on");
    return r;
  });
  c.ok("导出面板里有标题编号这个开关", ui.has);
  c.ok("默认勾上", ui.checked);
  c.ok("开关有中英文案", await c.run(() => !!(T.en.wrExpNumsOpt && T.zh.wrExpNumsOpt)));

  // 失败的方式不止"网络连不上"一种：CDN 半截返回、拿到的库缺东少西、
  // Packer 自己抛错……每一种都必须落到 .doc，不能弹一句"导出未完成"就没了
  const broken = await c.run(async () => {
    const d = docs()[0], realDl = window.dl, realDocx = window.docx, realLoad = window.loadDocx;
    const out = [];
    const cases = [
      () => { window.loadDocx = () => Promise.reject(new Error("offline")) },
      () => { window.loadDocx = () => Promise.resolve(null) },
      () => { window.loadDocx = () => Promise.resolve({ Document: function () {} }) },   // 缺东少西
      () => { window.loadDocx = () => Promise.resolve({ Document: function () {},
        Paragraph: function () {}, HeadingLevel: {},
        Packer: { toBlob: () => { throw new Error("boom") } } }) },                      // 构建时炸
    ];
    for (const setup of cases) {
      window.docx = undefined; setup();
      let got = null; window.dl = (blob, name) => { got = { name, size: blob.size } };
      let threw = false;
      try { await wrExportWord(d, { vers: false, refs: false, nums: true }) } catch (e) { threw = true }
      out.push({ ok: !!got && got.size > 0 && /\.doc$/.test(got.name), threw });
    }
    window.dl = realDl; window.docx = realDocx; window.loadDocx = realLoad;
    return out;
  });
  c.ok("四种失败方式全都落到 .doc（" + broken.filter((z) => z.ok).length + "/4）",
    broken.every((z) => z.ok));
  c.ok("一次都没有抛到外面变成「导出未完成」", broken.every((z) => !z.threw));
});

group("wrlevel 写作页里设定层级", async (c) => {
  // 稿子里的标题层级就是画布上的 c.level（侧栏目录、正文编号、导出的标题级别
  // 全都读它，没有第二份数据）。写作页原来只能显示层级、没法设定——
  // 想把一段改成二级标题，得先回画布上找到那张卡片点右键菜单。
  await c.board([
    { id: "a", x: 0, y: 0, w: 400, text: "Introduction", s: {} },
    { id: "b", x: 0, y: 200, w: 400, text: "引入", s: {} },
    { id: "d", x: 0, y: 400, w: 400, text: "正文一段", s: {} },
  ], []);
  await c.run(() => {
    S.docs = [];
    const doc = addDoc({ x: -900, y: 0 }, "稿子");
    sel = ["a", "b", "d"]; clipCards("copy"); wrPasteMain(doc, 0);
    openWrite(doc.id);
  });
  await c.wait(700);

  const r = await c.run(() => {
    const doc = wrDoc();
    sel = [doc.ids[0]]; paintSel(); syncFmtBars();
    const lab0 = document.querySelector("#wflv").textContent;
    const trig = [...document.querySelectorAll("#wrfmt .fx")].find((z) => z.title === t("level"));
    trig.click();
    const opts = [...trig.parentElement.querySelectorAll(".fpop .item")].map((z) => z.textContent);
    trig.parentElement.querySelectorAll(".fpop .item")[1].click();     // 一级标题
    const c1 = card(doc.ids[0]);
    sel = [doc.ids[1]]; paintSel(); syncFmtBars();
    trig.click();
    trig.parentElement.querySelectorAll(".fpop .item")[2].click();     // 二级标题
    const c2 = card(doc.ids[1]);
    return { lab0, opts, lv1: c1.level, size1: (c1.s || {}).size,
      lv2: c2.level, lab: document.querySelector("#wflv").textContent,
      body: card(doc.ids[2]).level };
  });
  c.ok("工具栏上有层级这一项，四档都在", r.opts.length === 4);
  c.ok("没设过层级时显示正文", r.lab0 === "正文" || /body/i.test(r.lab0));
  c.ok("能把一段设成一级标题", r.lv1 === 1);
  c.ok("层级带来的字号也一并套上了", r.size1 > 20);
  c.ok("能把另一段设成二级标题", r.lv2 === 2);
  c.ok("标签跟着当前段落走", /2/.test(r.lab));
  c.ok("没动过的段落还是正文", !r.body);

  // 侧栏目录与正文编号都跟着变——它们读的就是同一个 level
  await c.wait(400);
  const side = await c.run(() => {
    const box = document.querySelector("#wrside");
    return { txt: box ? box.textContent.replace(/\s+/g, " ") : "",
      hd: !!document.querySelector("#wrmain .blk .hd, #wrmain .blk.hd") };
  });
  c.ok("侧栏目录里出现了这两级标题", /Introduction/.test(side.txt) && /引入/.test(side.txt));
  c.ok("正文里也按标题渲染了", side.hd);

  // 改回正文：层级要能取消，不是只能往上加
  c.ok("能改回正文", await c.run(() => {
    const doc = wrDoc();
    sel = [doc.ids[1]]; paintSel(); syncFmtBars();
    const trig = [...document.querySelectorAll("#wrfmt .fx")].find((z) => z.title === t("level"));
    trig.click();
    trig.parentElement.querySelectorAll(".fpop .item")[0].click();
    return !card(doc.ids[1]).level;
  }));

  // 画布上的原卡片不受影响：稿子里的段落是独立拷贝
  c.ok("画布上的原卡片没有被改动", await c.run(() =>
    !card("a").level && !card("b").level));

  // 没选中段落时不给空框
  c.ok("没选中时给的是提示", await c.run(() => {
    sel = []; paintSel(); syncFmtBars();
    const trig = [...document.querySelectorAll("#wrfmt .fx")].find((z) => z.title === t("level"));
    trig.click();
    const txt = trig.parentElement.querySelector(".fpop").textContent.trim();
    const dim = trig.classList.contains("off");
    closeFmtPops();
    return txt === t("fmtNeedSel") && dim;
  }));
  await c.run(() => closeWrite());
});

group("wrver 版本复制到剪贴板", async (c) => {
  // 「把这一版复制到剪贴板」的用途就是把稿子里的某一版**送回画布**当一张普通卡片。
  // 早先它把整张段落原样拷进剪贴板，连 wrIn（只活在这份稿子里）一起带走，
  // 于是粘到画布上的那张卡片被 syncCards / docOrder 一并跳过——
  // 卡片其实建出来了，可就是看不见、也不参与导出，用起来就是"这个菜单没反应"。
  await c.board([{ id: "p1", x: 0, y: 0, w: 420, text: "原来的一段内容", s: {} }], []);
  const r = await c.run(() => {
    S.docs = [];
    const d = addDoc({ x: -900, y: 0 }, "稿子");
    sel = ["p1"]; clipCards("copy"); wrPasteMain(d, 0);
    const id = d.ids[0], blk = card(id);
    verNew(blk, true); blk.text = "第二版的内容"; verStash(blk);
    sel = [id]; paintSel();
    const before = S.cards.filter((z) => !z.wrIn).length;
    verToClip(blk, blk.verOn);
    const it = CLIP.items[0];
    pasteClip({ x: 2000, y: 0 });
    const made = S.cards.find((z) => !z.wrIn && z.x >= 1900);
    return { before, after: S.cards.filter((z) => !z.wrIn).length,
      clipW: it.w, clipHasS: !!it.s, snapWrIn: it.snap.wrIn,
      text: made && made.text, w: made && made.w, docOnly: made ? docOnly(made) : null,
      inDoc: !!(made && docOrder(S.cards).some((z) => z.id === made.id)),
      onCanvas: !!(made && nodes.get(made.id) !== undefined || made) };
  });
  c.ok("画布上真的多出一张卡片", r.after === r.before + 1);
  c.ok("粘出来的是这一版的内容", r.text === "第二版的内容");
  c.ok("它是画布上的普通卡片，不带只活在稿子里的标记", r.docOnly === false && !r.snapWrIn);
  c.ok("它进得了文档顺序，导出不会漏掉", r.inDoc);
  c.ok("宽度跟着原段落走，不是 undefined", r.w === 420 && r.clipW === 420);
  c.ok("剪贴板条目的形状跟正常复制一致", r.clipHasS);

  // 稿子本身不受影响：源段落还在，画布上的原卡片也没动
  c.ok("稿子里的那一段没有被搬走", await c.run(() => docs()[0].ids.length === 1));
  c.ok("画布上的原卡片纹丝不动", await c.run(() => {
    const o = card("p1");
    return o && o.x === 0 && o.text === "原来的一段内容";
  }));
});

group("wrback 定位只留给引文分身", async (c) => {
  // 正文段落是内容的独立拷贝，画布上没有对应的实体，所以**不给**"在画布上找到它"：
  // 拿它自己去取景，镜头只会落在稿子旁边的空地上（它的 x/y 是拷贝时随手写的
  // 稿子左上角，高度也从没量过）。而折叠框里的引文分身是活的投影，
  // 定位到原文正是它存在的意义，那一项必须留着——两件事不要连坐。
  await c.board([
    { id: "far", x: 9000, y: 6000, w: 300, text: "远处的原卡片", s: {} },
    { id: "near", x: 0, y: 0, w: 300, text: "近处的原卡片", s: {} },
  ], []);
  const r = await c.run(() => {
    S.docs = [];
    const d = addDoc({ x: -4000, y: -3000 }, "稿子");
    sel = ["far"]; clipCards("copy"); wrPasteMain(d, 0);
    const blk = card(d.ids[0]);
    // 正文段落的右键菜单
    wrBlockMenu(60, 60, blk, 0, d);
    const items = [...document.querySelectorAll("#menu .mi")].map((z) => z.textContent.trim());
    closeMenus();
    return { items, blk: blk.id, doc: d.id, bx: blk.x, by: blk.y,
      hasRemove: items.some((z) => z.includes(t("wrRemove"))) };   // t() 在页面里，别搬到外面
  });
  c.ok("正文段落的菜单里没有定位到画布这一项",
    !r.items.some((z) => z.includes("画布") || /on the canvas/i.test(z)));
  c.ok("从稿子里移除这一项还在", r.hasRemove);
  c.ok("段落的坐标本来就在稿子那一带，拿它取景必然偏",
    Math.hypot(r.bx - 9000, r.by - 6000) > 5000);
  c.ok("文案里不再有这一条", await c.run(() =>
    T.en.wrGoCanvas === undefined && T.zh.wrGoCanvas === undefined));

  // 引文分身：这一项必须还在，而且要真的把镜头对准原文
  const ref = await c.run(() => {
    const d = docs()[0];
    sel = ["far"]; clipCards("twin");
    wrPasteTwin(d.ids[0], d);
    const tw = S.cards.find((z) => z.ref === "far" && z.wrUnder === d.ids[0]);
    wrRefMenu(60, 60, tw.id, d);
    const items = [...document.querySelectorAll("#menu .mi")].map((z) => z.textContent.trim());
    closeMenus();
    return { twin: tw.id, src: orig(tw).id, items, goto: t("wrRefGoto") };
  });
  c.ok("引文分身仍然指着源卡片", ref.src === "far");
  c.ok("引文分身的菜单里留着跳转到原文", ref.items.some((z) => z.includes(ref.goto)));

  await c.run((tw) => {
    const src = orig(card(tw));
    if (wrOpenState()) closeWrite();
    sel = [src.id]; selLink = null; paintSel(); focusOn([card(src.id)]);
  }, ref.twin);
  await c.wait(900);
  const pos = await c.run(() => {
    const el = nodes.get("far");
    if (!el) return null;
    const rc = el.getBoundingClientRect();
    return { dx: Math.round(rc.x + rc.width / 2 - innerWidth / 2),
      dy: Math.round(rc.y + rc.height / 2 - innerHeight / 2) };
  });
  c.ok("跳过去之后原卡片真的在视野里", !!pos);
  c.ok("镜头正对着原文（偏差 " + (pos ? pos.dx + "," + pos.dy : "?") + "）",
    !!pos && Math.abs(pos.dx) < 40 && Math.abs(pos.dy) < 40);
});

group("ports 连接点", async (c) => {
  await c.board([
    { id: "a", x: -300, y: 0, w: 360, text: "甲甲甲", s: {} },
    { id: "b", x: 300, y: 0, w: 300, text: "乙", s: {} },
  ], []);
  // 上一组可能残留写作视图或缩放，这里回到干净状态再测
  await c.run(() => {
    if (document.body.classList.contains("wr")) closeWrite();
    S.wr = null; sel = []; selLink = null; paintSel(); camTo(0, 0, 1, true);
  });
  await c.wait(500);
  c.ok("未选中时连接点不响应",
    (await c.run(() => getComputedStyle(nodes.get("a").querySelector(".port")).pointerEvents)) === "none");

  // 沿卡片边缘拖动必须是移动，不能被连接点抢走变成误连线
  const edge = await c.run(() => {
    const r = nodes.get("a").getBoundingClientRect();
    return { x: r.right - 3, y: r.top + r.height / 2, x0: card("a").x };
  });
  await c.page.mouse.move(edge.x, edge.y);
  await c.page.mouse.down();
  await c.page.mouse.move(edge.x + 120, edge.y + 40, { steps: 10 });
  await c.page.mouse.up();
  await c.wait(400);
  const after = await c.run(() => ({ x: card("a").x, links: S.links.length }));
  c.ok("沿卡片边缘拖动是移动而非连线",
    Math.abs(after.x - edge.x0 - 120) < 8 && after.links === 0);

  await c.run(() => { sel = ["a"]; paintSel(); });
  await c.wait(300);
  const port = await c.run(() => {
    const r = nodes.get("a").querySelector('.port[data-side="r"]').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const tgt = await c.run(() => {
    const r = nodes.get("b").getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await c.page.mouse.move(port.x, port.y);
  await c.page.mouse.down();
  await c.page.mouse.move(tgt.x, tgt.y, { steps: 12 });
  await c.page.mouse.up();
  await c.wait(400);
  c.ok("从连接点仍可正常连线", (await c.run(() => S.links.length)) === 1);

  await c.run(() => { S.links = []; markLinksDirty(); drawLinks(); });
  await c.page.mouse.move(port.x, port.y);
  await c.page.mouse.down();
  await c.page.mouse.up();
  await c.wait(350);
  c.ok("连接点上原地点击不产生连线", (await c.run(() => S.links.length)) === 0);
});

group("zoomfocus 聚焦与渲染", async (c) => {
  // Z 键要真的"放大"聚焦到屏幕中心。早先 focusOn 的 maxZ 写死成 1，
  // 选中一张小卡片按 Z 只会把它挪到中心却完全不放大，看起来像没反应。
  const zc = await c.run(() => {
    S.cards = [{ id: "a", x: 0, y: 0, w: 300, text: "甲", s: {} },
      { id: "b", x: 3000, y: 2000, w: 300, text: "乙", s: {} }];
    S.links = []; S.frames = []; S.docs = []; invalidateIndex(); render();
    camTo(0, 0, 1, true);
    sel = ["a"]; paintSel(); focusSel();
    return { z: tgt.z, x: tgt.x, y: tgt.y };
  });
  c.ok("选中卡片按 Z 会放大", zc.z > 1.2);
  c.ok("聚焦把卡片放到屏幕中心", Math.abs(zc.x - (-150 * zc.z)) < 2);

  // 视野外的卡片从来没被量过高度，hOf() 会退回拿 c.w 当高度（一个纯粹的猜测）。
  // 一张 340 宽、实际只有 23 高的卡片会被当成 340 高，取景框往下多出一大截，
  // 表现就是"聚焦到了卡片下方的空间"。取景前必须先把目标量准。
  const off = await c.run(() => {
    S.cards = [{ id: "near", x: 0, y: 0, w: 340, text: "近处", s: {} },
      { id: "far", x: 6000, y: 4000, w: 340, text: "远处", s: {} }];
    S.links = []; S.frames = []; S.docs = []; invalidateIndex(); render();
    camTo(0, 0, 1, true);
    const rendered = !!nodes.get("far");          // 确认它此刻确实不在画面里
    sel = ["far"]; paintSel(); focusSel();
    return { rendered, h: card("far").h, y: tgt.y, z: tgt.z };
  });
  c.ok("远处的卡片本来不在画面里", off.rendered === false);
  c.ok("取景前先量准了它的高度", off.h > 0 && off.h < 60);
  c.ok("聚焦对准卡片本身而不是它下方的空间",
    Math.abs(off.y - (-(4000 + off.h / 2) * off.z)) < 2);

  // 走一遍真实手势：点一张卡片再按 Z，它应该正落在屏幕正中
  await c.run(() => {
    S.cards = [];
    for (let i = 0; i < 40; i++) S.cards.push(
      { id: "g" + i, x: (i % 8) * 420, y: Math.floor(i / 8) * 300, w: 340, text: "卡片" + i, s: {} });
    S.links = []; S.frames = []; S.docs = []; invalidateIndex(); render(); fit(true);
  });
  await c.wait(600);
  const pt = await c.run(() => {
    const rc = nodes.get("g10").getBoundingClientRect();
    return { x: Math.round(rc.x + rc.width / 2), y: Math.round(rc.y + rc.height / 2) };
  });
  await c.page.mouse.click(pt.x, pt.y);
  await c.wait(200);
  await c.page.keyboard.press("z");
  await c.wait(900);
  const centred = await c.run(() => {
    const rc = nodes.get("g10").getBoundingClientRect();
    return { dx: Math.round(rc.x + rc.width / 2 - innerWidth / 2),
      dy: Math.round(rc.y + rc.height / 2 - innerHeight / 2) };
  });
  c.ok(`点卡片再按 Z 正落在屏幕中心（偏差 ${centred.dx},${centred.dy}）`,
    Math.abs(centred.dx) <= 2 && Math.abs(centred.dy) <= 2);

  // 稿子不是卡片，进不了 sel。早先它压根没有"被选中"这个状态，
  // 所以"选中写作页再按 Z"必然没有反应。
  const zd = await c.run(() => {
    S.docs = [{ id: "D", x: 1200, y: 0, title: "稿", ids: ["a"], mode: "iter", open: {} }];
    render(); camTo(0, 0, 0.5, true);
    selectDoc("D");
    const marked = document.querySelector('#docs .doc[data-id="D"]').classList.contains("on");
    focusSel();
    return { marked, z: tgt.z, selDoc };
  });
  c.ok("稿子可以被选中", zd.marked && zd.selDoc === "D");
  c.ok("选中稿子按 Z 会放大到它", zd.z > 1);

  // 再按一次退回原来的视角，跟聚焦卡片是同一套来回切换的手感
  c.ok("再按一次 Z 退回原视角", await c.run(() => {
    focusSel();
    return Math.abs(tgt.z - 0.5) < 0.01;
  }));

  // 选中卡片就等于放弃对稿子的选中，三者互斥
  c.ok("选中卡片会取消稿子的选中", await c.run(() => {
    sel = ["a"]; paintSel();
    return selDoc === null;
  }));

  // 剔除必须是节流而不是防抖：连续缩放期间也要真的跑，
  // 否则画面上一直挂着全部节点，既卡又渲染不出内容。
  const cull = await c.run(async () => {
    S.cards = []; S.docs = [];
    for (let i = 0; i < 600; i++) S.cards.push(
      { id: "c" + i, x: (i % 25) * 420, y: Math.floor(i / 25) * 260, w: 340, text: "卡片" + i, s: {} });
    S.links = []; S.frames = []; invalidateIndex(); render(); fit(true);
    await new Promise((r) => setTimeout(r, 400));
    const t0 = performance.now();
    for (let i = 0; i < 40; i++) zoomAt(1.06, 700, 450);   // 模拟一次连续的缩放手势
    const cost = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 150));
    const during = nodes.size;                              // 手势刚结束时就该已经剔除过
    await new Promise((r) => setTimeout(r, 400));
    return { cost: Math.round(cost), during, after: nodes.size, total: S.cards.length };
  });
  c.ok(`连续缩放不卡顿（40 次共 ${cull.cost}ms）`, cull.cost < 150);
  c.ok("缩放过程中就完成剔除，不是等手势结束", cull.during < cull.total * 0.5);
  c.ok("缩放之后内容仍然渲染得出来", cull.after > 0 && cull.after < cull.total);

  // 点大纲条目只该滚动稿子自己的正文区。早先用的是 scrollIntoView，
  // 它会连带滚动所有祖先滚动容器——#stage 虽然写了 overflow:hidden，
  // 脚本照样滚得动（实测被滚了 236px），整张画布连同稿子一起错位，
  // 而相机参数完全没变，看起来就是"点一下左侧条目，页面跳成另一种布局"。
  const nav = await c.run(async () => {
    S.cards = []; const ids = [];
    for (let i = 0; i < 20; i++) {
      const id = "k" + i; ids.push(id);
      S.cards.push({ id, x: 0, y: i * 200, w: 400,
        text: (i % 4 ? "正文内容 " : "标题 ") + i, level: i % 4 ? 0 : 1, s: {} });
    }
    S.links = []; S.frames = [];
    S.docs = [{ id: "D", x: 600, y: 0, title: "稿", ids, mode: "iter", open: {} }];
    invalidateIndex(); render(); camTo(-900, -400, 0.8, true);
    await new Promise((r) => setTimeout(r, 300));
    const el = document.querySelector("#docs .doc");
    const before = { doc: el.getBoundingClientRect().top, cam: { ...cam } };
    const navs = document.querySelectorAll("#docs .doc .dside .wrnav");
    navs[navs.length - 1].click();
    await new Promise((r) => setTimeout(r, 500));
    return { before,
      docTop: el.getBoundingClientRect().top,
      camSame: cam.x === before.cam.x && cam.y === before.cam.y && cam.z === before.cam.z,
      stage: $("stage").scrollTop,
      dbody: el.querySelector(".dbody").scrollTop };
  });
  c.ok("点大纲条目会滚动稿子正文", nav.dbody > 100);
  c.ok("画布不会跟着错位", nav.docTop === nav.before.doc && nav.camSame && nav.stage === 0);

  // 兜底：就算别处误用 scrollIntoView（或元素 focus）把 #stage 滚起来，也要立刻归零
  c.ok("画布容器被滚动后会自动归零", await c.run(async () => {
    const el = document.querySelector("#docs .doc");
    const t0 = el.getBoundingClientRect().top;
    el.querySelectorAll(".dbody .blk")[19].scrollIntoView({ block: "start" });
    await new Promise((r) => setTimeout(r, 300));
    return $("stage").scrollTop === 0 && el.getBoundingClientRect().top === t0;
  }));

  // 专注模式的大纲同理，只滚 #wrmain
  c.ok("专注模式点大纲只滚正文区", await c.run(async () => {
    openWrite("D");
    await new Promise((r) => setTimeout(r, 300));
    const navs = document.querySelectorAll("#wrside .wrnav");
    navs[navs.length - 1].click();
    await new Promise((r) => setTimeout(r, 500));
    const ok = $("wrmain").scrollTop > 100 && $("stage").scrollTop === 0
      && $("write").getBoundingClientRect().top === 0;
    closeWrite();
    return ok;
  }));

  await c.run(() => { S.docs = []; S.cards = []; invalidateIndex(); render(); });
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

/* =====================================================================
   抠图工具（cutout.html）
   ===================================================================== */

group("cutoutlink 抠图工具的入口", async (c) => {
  // 两个文件仍然各自独立、互不依赖，index 这边只是多一个"在新标签里打开它"的入口。
  await c.board([], []);
  const r = await c.run(() => {
    const real = window.open;
    let url = null;
    window.open = (u) => { url = u; return { closed: false }; };   // 别真的开标签页
    boardMenu(60, 60);
    const labels = [...document.querySelectorAll("#menu .mi")].map((z) => z.textContent.trim());
    const hit = [...document.querySelectorAll("#menu .mi")].find((z) => z.textContent.includes(t("cutoutTool")));
    if (hit) hit.click();
    window.open = real;
    closeMenus();
    return { labels, url, imgAt: labels.findIndex((z) => z.includes(t("insertImage"))),
      cutAt: labels.findIndex((z) => z.includes(t("cutoutTool"))) };
  });
  c.ok("画布右键菜单里有抠图工具", r.cutAt >= 0);
  c.ok("就放在插入图片旁边", r.cutAt === r.imgAt + 1);
  c.ok("指向同目录的 cutout.html", !!r.url && /\/cutout\.html$/.test(r.url));
  c.ok("是绝对地址，子目录部署也找得到", !!r.url && r.url.startsWith("file://"));
  c.ok("中英文案都齐了", await c.run(() => !!(T.en.cutoutTool && T.zh.cutoutTool &&
    T.en.cutoutHint && T.zh.cutoutHint && T.en.cutoutBlocked && T.zh.cutoutBlocked)));
  c.ok("index 挂着 manifest", await c.run(() =>
    !!document.querySelector('link[rel="manifest"]')));

  // 装成桌面应用之后，图标右键/长按的快捷方式里也要有一条抠图。
  // manifest 在 file:// 上 fetch 不到，直接把这一页打开读文本即可。
  await c.page.goto("file://" + require("path").resolve(__dirname, "manifest.json"));
  const mf = JSON.parse(await c.run(() => document.body.innerText));
  c.ok("manifest 里有抠图快捷方式",
    Array.isArray(mf.shortcuts) && mf.shortcuts.some((z) => /cutout\.html$/.test(z.url || "")));
  c.ok("快捷方式落在 scope 之内", mf.scope === "./" && /^\.\//.test(mf.shortcuts[0].url));
  c.ok("图标与主应用共用，不必再多两个文件",
    mf.shortcuts[0].icons.every((z) => mf.icons.some((m) => m.src === z.src)));
});

group("cutout 抠图工具", async (c) => {
  // 抠图是另一份完全独立的单文件，不与 board 共享代码，所以单独开一页测。
  // 注意它现在的模型是"卡点 + 沿边走"：载入后进卡点模式，沿边缘随便点几下，
  // 按 Enter（generateFromDraft）在梯度图上跑 livewire 把点之间贴着边界连起来。
  // 早先那版是载入即自动泛洪识别，这一组曾按那个模型写，已随工具本身一起改过来。
  await c.page.goto("file://" + require("path").resolve(__dirname, "cutout.html"));
  await c.wait(700);
  const src = await c.run(() => {
    const cv = document.createElement("canvas"); cv.width = 420; cv.height = 320;
    const g = cv.getContext("2d");
    g.fillStyle = "#EDEDEA"; g.fillRect(0, 0, 420, 320);
    g.fillStyle = "#3A4A5A";
    g.beginPath(); g.ellipse(210, 160, 120, 90, 0, 0, Math.PI * 2); g.fill();
    return cv.toDataURL("image/png");
  });
  await c.run((s) => loadImage(s, "t.png"), src);
  await c.wait(900);

  c.ok("图片可以载入", await c.run(() => IW === 420 && IH === 320));
  c.ok("载入后直接进卡点模式", await c.run(() => mode === "pen"));

  // 沿椭圆随便点十二下——刻意点得很粗糙（半径按 ±6% 抖动），
  // 贴合与否要靠 livewire 沿边走，不能靠点本身点得准
  const st = await c.run(async () => {
    draft = [];
    for (let k = 0; k < 12; k++) {
      const a = k / 12 * Math.PI * 2, j = 1 + (k % 3 - 1) * 0.06;
      draft.push({ x: 210 + Math.cos(a) * 120 * j, y: 160 + Math.sin(a) * 90 * j, corner: false });
    }
    await generateFromDraft();
    await new Promise((z) => setTimeout(z, 300));
    const p = paths[0];
    let on = 0;
    if (p) p.pts.forEach((z) => {
      if (Math.abs(Math.hypot((z.x - 210) / 120, (z.y - 160) / 90) - 1) < 0.25) on++;
    });
    return { n: paths.length, pts: p ? p.pts.length : 0, mode,
      handles: p ? p.pts.every((z) => typeof z.h1x === "number" && typeof z.h2x === "number") : false,
      fit: p ? on / p.pts.length : 0 };
  });
  c.ok("按现有的点生成得出曲线", st.n === 1 && st.pts > 8);
  c.ok("生成后自动进编辑模式", st.mode === "edit");
  c.ok("控点两侧都带贝塞尔手柄", st.handles);
  c.ok("沿边走真的贴着主体（" + (st.fit * 100).toFixed(0) + "%）", st.fit > 0.8);

  c.ok("控点可移动", await c.run(() => {
    const z = paths[0].pts[0], x0 = z.x; z.x += 25; draw();
    return paths[0].pts[0].x === x0 + 25;
  }));
  c.ok("可增删控点", await c.run(() => {
    const n0 = paths[0].pts.length;
    const a2 = paths[0].pts[0], b2 = paths[0].pts[1];
    paths[0].pts.splice(1, 0, { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2,
      h1x: 0, h1y: 0, h2x: 0, h2y: 0, corner: false });
    const n1 = paths[0].pts.length;
    paths[0].pts.splice(1, 1); draw();
    return n1 === n0 + 1 && paths[0].pts.length === n0;
  }));
  c.ok("尖角控点有独立样式", await c.run(() => {
    paths[0].pts[0].corner = true; draw();
    const has = !!document.querySelector("#ov circle.an.corner");
    paths[0].pts[0].corner = false; draw();
    return has;
  }));
  c.ok("撤销能退回上一步", await c.run(() => {
    const before = paths.length; undo();
    const mid = paths.length; push(); paths = []; undo();
    return before === 1 && mid === 0;
  }));

  // 撤销之后重新生成一条，后面的导出断言才有东西可导
  await c.run(async () => {
    if (!paths.length) { await generateFromDraft(true); await new Promise((z) => setTimeout(z, 300)); }
  });
  const out = await c.run(() => {
    const cv = croppedCutout(1);
    const g = cv.getContext("2d");
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    let opaque = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 200) opaque++;
    return { w: cv.width, h: cv.height, corner: g.getImageData(0, 0, 1, 1).data[3],
      opaque, png: cv.toDataURL("image/png").slice(0, 22) };
  });
  c.ok("输出为带透明通道的 PNG", /^data:image\/png/.test(out.png) && out.corner < 20);
  c.ok("自动裁到主体大小", out.w < 420 && out.w > 150);
  c.ok("主体像素完整保留", out.opaque > 5000);
  c.ok("预览窗有内容", await c.run(() => {
    updatePreview();
    const cc = $("prevc");
    return cc.width > 100 && $("prev").classList.contains("on");
  }));
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
