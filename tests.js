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
  const op = await c.run(() => document.querySelector("#links path.ln")?.getAttribute("stroke-opacity"));
  c.ok("连线在鼠标移开后依然可见", op === "1");

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
  c.ok("导出时源正文只出现一次", (doc.match(/<p>改过的内容[^<]*<\/p>/g) || []).length === 1);
  c.ok("导出时分身写成引用行", /class="rel">&#9672;/.test(doc));

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
  await c.run(() => { sel = ["a"]; setCardLock(null, true); });
  await c.wait(300);
  c.ok("卡片可以单独锁定", (await c.run(() => isLocked("a"))) === true);
  c.ok("锁定后不显示额外标注", await c.run(() => !nodes.get("a")?.querySelector(".lockmk")));
  c.ok("锁定后隐藏缩放控制点", await c.run(() => getComputedStyle(nodes.get("a").querySelector(".hnd")).display === "none"));
  // 锁定会顺着连线扩散一层
  c.ok("相连的卡片一同锁定", (await c.run(() => isLocked("b"))) === true);

  // 锁定后不可移动、不可编辑、不可删除
  const x0 = await c.run(() => card("a").x);
  await c.run(() => { sel = ["a"]; startMove({ clientX: 0, clientY: 0, shiftKey: false }); });
  await c.wait(150);
  c.ok("锁定后不可移动", (await c.run(() => card("a").x)) === x0);
  await c.run(() => { sel = ["a"]; editText(card("a")); });
  await c.wait(200);
  c.ok(
    "锁定后不可编辑文字",
    await c.run(() => !nodes.get("a").querySelector(".cap").isContentEditable)
  );
  await c.run(() => { sel = ["a"]; setStyle("size", 40); });
  await c.wait(200);
  c.ok("锁定后不可改样式", await c.run(() => !card("a").s || card("a").s.size !== 40));
  await c.run(() => { sel = ["a"]; del(); });
  await c.wait(200);
  c.ok("锁定后不可删除", (await c.run(() => S.cards.length)) === 2);

  // 连线随卡片一同锁定
  await c.run(() => { selLink = "L"; sel = []; del(); });
  await c.wait(200);
  c.ok("相连的连线也不可删除", (await c.run(() => S.links.length)) === 1);

  // 页面整体移动时锁定卡片仍然跟随
  await c.run(() => {
    const f = S.frames[0];
    const kids = inFrame(f);
    const dx = 500;
    f.x += dx;
    kids.forEach((z) => (z.x += dx));
    render();
  });
  await c.wait(250);
  c.ok("页面移动时锁定卡片跟随", (await c.run(() => card("a").x)) === x0 + 500);

  // 锁定状态下仍可创建分身
  await c.run(() => { sel = ["a"]; clipCards("twin"); pasteClip({ x: 3000, y: 3000 }); });
  await c.wait(400);
  c.ok("锁定状态下仍可创建分身", (await c.run(() => S.cards.filter((z) => z.ref === "a").length)) === 1);
  c.ok("新建的分身本身未被锁定", await c.run(() => !S.cards.find((z) => z.ref === "a").lock));

  await c.run(() => { sel = ["a"]; setCardLock(null, false); });
  await c.wait(250);
  c.ok("可以解锁", (await c.run(() => isLocked("a"))) === false);
  c.ok("解锁同样扩散到相连卡片", (await c.run(() => isLocked("b"))) === false);

  // 没有连线的卡片不受牵连
  await c.run(() => {
    S.cards.push({ id: "z", x: 900, y: 900, w: 200, text: "无关", s: {} });
    sel = ["a"]; render(); setCardLock(null, true);
  });
  await c.wait(300);
  c.ok("未相连的卡片不被牵连", (await c.run(() => !isLocked("z"))) === true);
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
      { id: "h1", x: -800, y: -300, w: 300, text: "第一章 引论", level: 1, s: {} },
      { id: "p1", x: -800, y: -150, w: 300, text: "正文一 #方法", url: "https://doi.org/10.1000/x", s: {} },
      { id: "h2", x: 200, y: -300, w: 300, text: "第二章 方法", level: 1, s: {} },
      { id: "p2", x: 200, y: -150, w: 300, text: "正文二", s: {} },
    ],
    [{ id: "L", a: "p1", b: "p2", kind: "curve", arrow: "none", w: 1.4, color: "#8A8A85", note: "相互印证" }],
    {
      frames: [
        { id: "f1", x: -900, y: -380, w: 520, h: 400, title: "第一章" },
        { id: "f2", x: 100, y: -380, w: 520, h: 400, title: "第二章" },
      ],
    }
  );
  c.ok(
    "页面分组正确",
    (await c.run(() => pageGroups(null).map((g) => g.title + ":" + g.cards.length).join("|"))) === "第一章:2|第二章:2"
  );

  const arc = await c.zipNames(
    `exportArchive({title:'ARCH',img:true,tags:true,refs:true,table:true,scale:1,shots:false})`
  );
  c.ok("存档含每页 Markdown", arc.names.filter((n) => n.startsWith("pages/") && n.endsWith(".md")).length === 2);
  c.ok("存档含完整数据文件", arc.names.includes("board.json"));
  c.ok("存档含说明文件", arc.names.includes("README.md"));

  const shots = await c.zipNames(`exportPageShots({title:'PG',scale:1,scope:'all'})`);
  c.ok("分页图片各成一张打包", shots.names.length === 2 && shots.names.every((n) => n.endsWith(".jpg")));
});

/* =====================================================================
   11. 数据安全：版本、快照、导入容错
   ===================================================================== */

group("data 数据安全", async (c) => {
  await c.board([{ id: "a", x: 0, y: 0, w: 300, text: "内容", s: {} }], []);
  c.ok("导出数据带版本号", (await c.run(() => bundle(null).v)) === 4);

  // 旧版的"已锁定编组"要迁移成卡片自身的锁定，锁定状态不能丢
  const mig = await c.run(() =>
    migrate({
      v: 3,
      cards: [{ id: "g1", x: 0, y: 0, w: 200, text: "旧锁定卡" }, { id: "g2", x: 300, y: 0, w: 200, text: "普通卡" }],
      groups: [{ id: "gg", ids: ["g1"], locked: true }],
    })
  );
  c.ok("旧编组的锁定状态迁移到卡片", mig.cards[0].lock === true && !mig.cards[1].lock);
  c.ok("迁移后编组字段被移除", !mig.groups && mig.v === 4);

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
