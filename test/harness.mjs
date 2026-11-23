import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

const chain = [
	{ provider: "p0", model: "m0", label: "线路0" },
	{ provider: "p1", model: "m1", label: "线路1" },
	{ provider: "p2", model: "m2", label: "线路2" },
	{ provider: "p3", model: "m3", label: "线路3" },
	{ provider: "p4", model: "m4", label: "线路4" },
];

const baseConfig = {
	enabled: true,
	cooldownMs: 1800000,
	notice: true,
	on: ["QUOTA_EXCEEDED", "SERVER", "TIMEOUT", "UNSUPPORTED_REASONING_EFFORT", "MISSING_CREDENTIAL"],
	chain,
};

const text = (index, t) => ({ type: "text-delta", index, text: t });
const blockStart = (index) => ({ type: "block-start", index, blockType: "text" });
const blockEnd = (index, t) => ({ type: "block-end", index, block: { type: "text", text: t } });
const reasonStart = (index) => ({ type: "block-start", index, blockType: "reasoning" });
const reasonDelta = (index, t) => ({ type: "reasoning-delta", index, text: t });
const toolDelta = (index, name, args) => ({ type: "tool-call-delta", index, id: `call-${index}`, name, argumentsDelta: args });
const ok = { type: "finish", reason: { kind: "stop" } };
const boom = (code) => ({ type: "finish", reason: { kind: "error", failure: { message: code, code } } });

function makeCtx(routes, config = baseConfig) {
	const logs = [];
	const calls = [];
	const args = [];
	let listener;
	const behavior = (options) => {
		calls.push(`${options.provider}/${options.model}`);
		args.push(options);
		const key = `${options.provider}/${options.model}`;
		const fn = routes[key];
		if (fn === undefined) return (async function* () { yield ok; })();
		return fn(options);
	};
	const ctx = {
		logger: {
			info: (m) => logs.push(String(m)),
			warn: (m) => logs.push(String(m)),
			error: (m) => logs.push(String(m)),
			debug: () => {},
		},
		on(event, fn) {
			if (event === "llm/stream") listener = fn;
		},
		llm: { stream: (options) => listener(options, () => behavior(options)) },
	};
	apply(ctx, config);
	const drive = async (options) => {
		const out = [];
		for await (const chunk of listener(options, () => behavior(options))) out.push(chunk);
		return out;
	};
	return { drive, calls, logs, args, hasListener: () => listener !== undefined };
}

const request = (provider, model, extra = {}) => ({
	provider,
	model,
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
	signal: new AbortController().signal,
	...extra,
});

const noticeOf = (out) => out.filter((c) => c.type === "text-delta" && String(c.text).includes("〔自动换线〕"));

const cases = [];
const test = (title, fn) => cases.push({ title, fn });

test("主线路立刻失败 -> 换第第二条并留提示", async () => {
	const h = makeCtx({
		"p0/m0": async function* () { yield boom("QUOTA_EXCEEDED"); },
		"p1/m1": async function* () { yield blockStart(0); yield text(0, "你好"); yield blockEnd(0, "你好"); yield ok; },
	});
	const out = await h.drive(request("p0", "m0"));
	assert.deepEqual(h.calls, ["p0/m0", "p1/m1"]);
	const notice = noticeOf(out);
	assert.equal(notice.length, 1, "应有一行提示");
	assert.match(notice[0].text, /线路0 失败（QUOTA_EXCEEDED）/);
	assert.match(notice[0].text, /这一轮走 线路1/);
	assert.equal(out.at(-1).reason.kind, "stop");
	assert.equal(out[0].type, "block-start", "正文块的开头要先出去");
	assert.equal(out[1].type, "text-delta");
	assert.equal(out[1].index, 0, "提示要落在同一个块索引里");
	assert.match(out[1].text, /^〔自动换线〕/);
});

test("已经吐了内容才断 -> 不换线，直接报错", async () => {
	const h = makeCtx({
		"p0/m0": async function* () { yield blockStart(0); yield text(0, "半句"); yield boom("SERVER"); },
		"p1/m1": async function* () { yield blockStart(0); yield text(0, "不该到这里"); yield ok; },
	});
	const out = await h.drive(request("p0", "m0"));
	assert.deepEqual(h.calls, ["p0/m0"]);
	assert.equal(out.at(-1).reason.kind, "error");
	assert.equal(out.at(-1).reason.failure.code, "SERVER");
	assert.equal(noticeOf(out).length, 0);
});

test("不在顺序表里的模型 -> 完全不介入", async () => {
	const h = makeCtx({});
	const out = await h.drive(request("other", "x"));
	assert.deepEqual(h.calls, ["other/x"]);
	assert.equal(out.at(-1).reason.kind, "stop");
});

test("冷却：第二条请求跳过刚坏的线路", async () => {
	const h = makeCtx({
		"p0/m0": async function* () { yield boom("QUOTA_EXCEEDED"); },
		"p1/m1": async function* () { yield blockStart(0); yield text(0, "第一轮"); yield blockEnd(0, "第一轮"); yield ok; },
	});
	await h.drive(request("p0", "m0"));
	h.calls.length = 0;
	const out = await h.drive(request("p0", "m0"));
	assert.deepEqual(h.calls, ["p1/m1"], "第二轮不该再撞第一条");
	const notice = noticeOf(out);
	assert.equal(notice.length, 1);
	assert.match(notice[0].text, /先跳过它/);
});

test("档位不支持 -> 同一条线路降档重试，不跳线", async () => {
	let attempts = 0;
	const h = makeCtx({
		"p0/m0": async function* (options) {
			attempts += 1;
			if (options.reasoningEffort !== undefined) {
				yield boom("UNSUPPORTED_REASONING_EFFORT");
				return;
			}
			yield blockStart(0);
			yield text(0, "降档后成功");
			yield blockEnd(0, "降档后成功");
			yield ok;
		},
		"p1/m1": async function* () { yield blockStart(0); yield text(0, "不该到这里"); yield ok; },
	});
	const out = await h.drive(request("p0", "m0", { reasoningEffort: "high" }));
	assert.deepEqual(h.calls, ["p0/m0", "p0/m0"]);
	assert.equal(attempts, 2);
	assert.equal(out.at(-1).reason.kind, "stop");
	assert.equal(noticeOf(out).length, 0, "同线路重试不该出换线提示");
});

test("五条全挂 -> 保留最后一条的错误码，并把试过的顺序写进报错", async () => {
	const h = makeCtx({
		"p0/m0": async function* () { yield boom("SERVER"); },
		"p1/m1": async function* () { yield boom("SERVER"); },
		"p2/m2": async function* () { yield boom("SERVER"); },
		"p3/m3": async function* () { yield boom("SERVER"); },
		"p4/m4": async function* () { yield boom("MISSING_CREDENTIAL"); },
	});
	const out = await h.drive(request("p0", "m0"));
	assert.equal(h.calls.length, 5);
	assert.equal(out.at(-1).reason.failure.code, "MISSING_CREDENTIAL", "错误码不能被改写");
	const message = out.at(-1).reason.failure.message;
	assert.match(message, /按顺序试过 线路0 → 线路1 → 线路2 → 线路3 → 线路4/);
	assert.match(message, /没有可用的线路了/);
	assert.equal(noticeOf(out).length, 0);
});

test("冷却：过期后重新从链首来，递进时跳过还在冷却的线路", async () => {
	let clock = 1_000;
	const realNow = Date.now;
	Date.now = () => clock;
	try {
		let first = true;
		const h = makeCtx({
			"p0/m0": async function* () { yield boom("SERVER"); },
			"p1/m1": async function* () {
				if (first) {
					first = false;
					yield blockStart(0);
					yield text(0, "第一次还行");
					yield blockEnd(0, "第一次还行");
					yield ok;
					return;
				}
				yield boom("QUOTA_EXCEEDED");
			},
			"p2/m2": async function* () { yield blockStart(0); yield text(0, "走到这里"); yield blockEnd(0, "走到这里"); yield ok; },
		}, { ...baseConfig, cooldownMs: 1_000 });
		await h.drive(request("p0", "m0"));
		assert.deepEqual(h.calls, ["p0/m0", "p1/m1"]);
		h.calls.length = 0;
		clock = 1_900;
		await h.drive(request("p0", "m0"));
		assert.deepEqual(h.calls, ["p1/m1", "p2/m2"], "链首还在冷却，这一轮从线路1起");
		h.calls.length = 0;
		clock = 2_100;
		const out = await h.drive(request("p0", "m0"));
		assert.deepEqual(h.calls, ["p0/m0", "p2/m2"], "线路1还在冷却，递进时要跳过它");
		const notice = noticeOf(out);
		assert.equal(notice.length, 1);
		assert.match(notice[0].text, /线路1 还在冷却，跳过/);
		assert.equal(out.at(-1).reason.kind, "stop");
	} finally {
		Date.now = realNow;
	}
});

test("手选链里的其它线路 -> 完全不介入，失败就报错", async () => {
	const h = makeCtx({
		"p2/m2": async function* () { yield boom("SERVER"); },
	});
	const out = await h.drive(request("p2", "m2"));
	assert.deepEqual(h.calls, ["p2/m2"]);
	assert.equal(out.at(-1).reason.failure.code, "SERVER");
	assert.equal(noticeOf(out).length, 0);
});

test("不在名单里的错误码 -> 不换线", async () => {
	const h = makeCtx({
		"p0/m0": async function* () { yield boom("CONTEXT_WINDOW_EXCEEDED"); },
	});
	const out = await h.drive(request("p0", "m0"));
	assert.deepEqual(h.calls, ["p0/m0"]);
	assert.equal(out.at(-1).reason.failure.code, "CONTEXT_WINDOW_EXCEEDED");
});

test("自己取消 -> 不换线", async () => {
	const controller = new AbortController();
	const h = makeCtx({
		"p0/m0": async function* () { controller.abort(); yield boom("ABORTED"); },
	});
	const out = await h.drive(request("p0", "m0", { signal: controller.signal }));
	assert.deepEqual(h.calls, ["p0/m0"]);
	assert.equal(out.at(-1).reason.failure.code, "ABORTED");
});

test("总开关关掉 -> 根本不挂监听", async () => {
	const h = makeCtx({}, { ...baseConfig, enabled: false });
	assert.equal(h.hasListener(), false);
});

test("备用线路只有 delta、没有 block-start -> 照样提示，正文完整", async () => {
	const h = makeCtx({
		"p0/m0": async function* () { yield boom("QUOTA_EXCEEDED"); },
		"p1/m1": async function* () { yield text(0, "你好"); yield ok; },
	});
	const out = await h.drive(request("p0", "m0"));
	const notice = noticeOf(out);
	assert.equal(notice.length, 1, "delta-only 流也要出提示");
	assert.match(notice[0].text, /这一轮走 线路1/);
	assert.equal(notice[0].index, 0, "提示要和正文落在同一个块");
	assert.ok(out.indexOf(notice[0]) < out.findIndex((c) => c.type === "text-delta" && c.text === "你好"), "提示要在正文前面");
	assert.ok(out.some((c) => c.type === "text-delta" && c.text === "你好"), "正文不能丢");
});

test("备用线路先推理再正文 -> 提示只进正文块，不污染推理", async () => {
	const h = makeCtx({
		"p0/m0": async function* () { yield boom("SERVER"); },
		"p1/m1": async function* () {
			yield reasonStart(0);
			yield reasonDelta(0, "想想");
			yield blockStart(1);
			yield text(1, "答案");
			yield blockEnd(1, "答案");
			yield ok;
		},
	});
	const out = await h.drive(request("p0", "m0"));
	const notice = noticeOf(out);
	assert.equal(notice.length, 1);
	assert.equal(notice[0].index, 1, "提示必须落在正文块");
	assert.equal(out.filter((c) => c.type === "reasoning-delta" && String(c.text).includes("自动换线")).length, 0);
	assert.equal(out[0].type, "block-start", "推理块的正常顺序不能被拆坏");
	assert.equal(out[0].blockType, "reasoning");
	assert.equal(out[1].type, "reasoning-delta");
});

test("只有推理就失败 -> 继续换线，不算已开口", async () => {
	const h = makeCtx({
		"p0/m0": async function* () { yield boom("SERVER"); },
		"p1/m1": async function* () { yield reasonDelta(0, "想一想"); yield boom("TIMEOUT"); },
		"p2/m2": async function* () { yield blockStart(0); yield text(0, "最后还是到了"); yield blockEnd(0, "最后还是到了"); yield ok; },
	});
	const out = await h.drive(request("p0", "m0"));
	assert.deepEqual(h.calls, ["p0/m0", "p1/m1", "p2/m2"], "纯推理不该锁死换线");
	assert.equal(out.at(-1).reason.kind, "stop");
	const notice = noticeOf(out);
	assert.equal(notice.length, 1);
	assert.match(notice[0].text, /线路1 失败（TIMEOUT）/);
	assert.match(notice[0].text, /这一轮走 线路2/);
});

test("工具调用转出去就停止换线", async () => {
	const h = makeCtx({
		"p0/m0": async function* () { yield boom("SERVER"); },
		"p1/m1": async function* () { yield toolDelta(0, "read", "{\"path\":\"a\"}"); yield boom("SERVER"); },
		"p2/m2": async function* () { yield blockStart(0); yield text(0, "不该到这里"); yield ok; },
	});
	const out = await h.drive(request("p0", "m0"));
	assert.deepEqual(h.calls, ["p0/m0", "p1/m1"]);
	assert.equal(out.at(-1).reason.kind, "error");
	assert.equal(noticeOf(out).length, 0, "工具块里不能塞提示");
});

test("备用线路一句正文都没有 -> 提示自己成一块", async () => {
	const h = makeCtx({
		"p0/m0": async function* () { yield boom("SERVER"); },
		"p1/m1": async function* () { yield reasonStart(0); yield reasonDelta(0, "只想了"); yield ok; },
	});
	const out = await h.drive(request("p0", "m0"));
	const notice = noticeOf(out);
	assert.equal(notice.length, 1, "没正文也要让人看见换过线");
	const index = notice[0].index;
	assert.notEqual(index, 0, "提示不能挤进推理块");
	const blockStartChunk = out.find((c) => c.type === "block-start" && c.index === index && c.blockType === "text");
	const blockEndChunk = out.find((c) => c.type === "block-end" && c.index === index);
	assert.ok(blockStartChunk !== undefined, "提示块要有开头");
	assert.ok(blockEndChunk !== undefined, "提示块要闭合");
	assert.match(blockEndChunk.block.text, /〔自动换线〕/);
	assert.equal(out.at(-1).type, "finish");
});

test("提示不会被 usage 和空 delta 打乱", async () => {
	const h = makeCtx({
		"p0/m0": async function* () { yield boom("SERVER"); },
		"p1/m1": async function* () {
			yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
			yield reasonDelta(0, ".");
			yield text(0, "");
			yield blockStart(1);
			yield text(1, "正文");
			yield blockEnd(1, "正文");
			yield ok;
		},
	});
	const out = await h.drive(request("p0", "m0"));
	const notice = noticeOf(out);
	assert.equal(notice.length, 1);
	assert.equal(notice[0].index, 1);
});

test("链尾是兜底线路 -> 永不进冷却，中间全冷却时只剩它可试", async () => {
	let clock = 1_000;
	const realNow = Date.now;
	Date.now = () => clock;
	try {
		const h = makeCtx({
			"p0/m0": async function* () { yield boom("SERVER"); },
			"p1/m1": async function* () { yield boom("SERVER"); },
			"p2/m2": async function* () { yield boom("SERVER"); },
			"p3/m3": async function* () { yield boom("SERVER"); },
			"p4/m4": async function* () { yield boom("SERVER"); },
		}, { ...baseConfig, cooldownMs: 1_000 });
		await h.drive(request("p0", "m0"));
		assert.deepEqual(h.calls, ["p0/m0", "p1/m1", "p2/m2", "p3/m3", "p4/m4"]);
		h.calls.length = 0;
		const out = await h.drive(request("p0", "m0"));
		assert.deepEqual(h.calls, ["p4/m4"], "中间四条都在冷却，链尾照样能试");
		assert.match(out.at(-1).reason.failure.message, /按顺序试过 线路4/);
		assert.equal(out.at(-1).reason.failure.code, "SERVER", "错误码不能被改写");
	} finally {
		Date.now = realNow;
	}
});

test("中间全冷却 + 链尾兜底成功 -> 只走链尾，并留提示与跳过说明", async () => {
	let clock = 1_000;
	const realNow = Date.now;
	Date.now = () => clock;
	try {
		const h = makeCtx({
			"p0/m0": async function* () { yield boom("SERVER"); },
			"p1/m1": async function* () { yield boom("SERVER"); },
			"p2/m2": async function* () { yield boom("SERVER"); },
			"p3/m3": async function* () { yield boom("SERVER"); },
			"p4/m4": async function* () { yield blockStart(0); yield text(0, "兜底答的"); yield blockEnd(0, "兜底答的"); yield ok; },
		}, { ...baseConfig, cooldownMs: 1_000 });
		await h.drive(request("p0", "m0"));
		assert.deepEqual(h.calls, ["p0/m0", "p1/m1", "p2/m2", "p3/m3", "p4/m4"]);
		h.calls.length = 0;
		const out = await h.drive(request("p0", "m0"));
		assert.deepEqual(h.calls, ["p4/m4"], "冷却中的线路一条都不试");
		const notice = noticeOf(out);
		assert.equal(notice.length, 1);
		assert.match(notice[0].text, /线路4/);
		assert.match(notice[0].text, /还在冷却，先跳过/);
		assert.equal(out.at(-1).reason.kind, "stop");
	} finally {
		Date.now = realNow;
	}
});

test("单次请求卡住 -> 到点放掉，换下一条", async () => {
	const h = makeCtx({
		"p0/m0": async function* () { await new Promise(() => {}); },
		"p1/m1": async function* () { yield blockStart(0); yield text(0, "换过来了"); yield blockEnd(0, "换过来了"); yield ok; },
	}, { ...baseConfig, attemptMs: 30 });
	const out = await h.drive(request("p0", "m0"));
	assert.deepEqual(h.calls, ["p0/m0", "p1/m1"]);
	const notice = noticeOf(out);
	assert.equal(notice.length, 1);
	assert.match(notice[0].text, /TIMEOUT/);
	assert.ok(out.some((c) => c.type === "text-delta" && c.text === "换过来了"), "备用线路的正文要到");
});

test("整条链的总时限用完 -> 不再往后试，报错里写着总时限", async () => {
	const hang = async function* () { await new Promise(() => {}); };
	const h = makeCtx({
		"p0/m0": hang,
		"p1/m1": hang,
		"p2/m2": hang,
		"p3/m3": hang,
		"p4/m4": hang,
	}, { ...baseConfig, attemptMs: 1_000, budgetMs: 40 });
	const out = await h.drive(request("p0", "m0"));
	assert.ok(h.calls.length >= 1, "至少要试过链首");
	assert.ok(h.calls.length < 5, "预算用完了就不再往后试");
	assert.equal(out.at(-1).reason.failure.code, "TIMEOUT");
	assert.match(out.at(-1).reason.failure.message, /按顺序试过/);
});

let failed = 0;
for (const { title, fn } of cases) {
	try {
		await fn();
		console.log(`PASS  ${title}`);
	} catch (error) {
		failed += 1;
		console.log(`FAIL  ${title}`);
		console.log(`      ${error.message}`);
	}
}
console.log(failed === 0 ? `\n全部 ${cases.length} 项通过` : `\n${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
