// 校验 cordis.patch.yml：结构对得上才让提交过。
// 昨天就是在 config 块里写了两空格缩进的行，YAML 直接炸在 18:9，插件整块没加载。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const file = process.env.PATCH_FILE ?? join(here, "..", "cordis.patch.yml");
const problems = [];

let text;
try {
	text = readFileSync(file, "utf8");
} catch (error) {
	console.error(`读不到 ${file}: ${error.message}`);
	process.exitCode = 1;
	throw error;
}

/** 去掉空行与纯注释行，留下带缩进的正文。 */
const rows = [];
text.split(/\r?\n/).forEach((raw, i) => {
	const trimmed = raw.trim();
	if (trimmed === "" || trimmed.startsWith("#")) return;
	const lead = raw.slice(0, raw.length - raw.trimStart().length);
	if (lead.includes("\t")) problems.push(`第 ${i + 1} 行：缩进里有 tab，YAML 只认空格`);
	rows.push({ line: i + 1, indent: lead.length, text: trimmed });
});

if (rows.length === 0) problems.push("文件是空的");

/** 同一个父层下面，所有孩子必须用同一个缩进。昨天就是把 8 空格的孩子写成了 2 空格。 */
const child = new Map();
const stack = [0];
let previous = null;
for (const row of rows) {
	while (stack.length > 1 && row.indent < stack[stack.length - 1]) stack.pop();
	const parent = stack[stack.length - 1];
	if (row.indent > parent) {
		const known = child.get(parent);
		if (known !== undefined && known !== row.indent) {
			problems.push(`第 ${row.line} 行：缩进 ${row.indent}，但同一层别处用的是 ${known} ——「${row.text}」`);
		}
		const opener = previous && (previous.text.endsWith(":") || previous.text.startsWith("-"));
		if (previous && !opener) {
			problems.push(`第 ${row.line} 行：缩进加深了，但上一行不是以冒号或短横结尾 ——「${row.text}」`);
		}
		child.set(parent, row.indent);
		stack.push(row.indent);
	} else if (row.indent < parent) {
		problems.push(`第 ${row.line} 行：缩进 ${row.indent} 对不上任何外层（最近一层是 ${parent}）——「${row.text}」`);
	}
	previous = row;
}

const first = rows[0];
if (first && first.indent !== 0) problems.push(`第 ${first.line} 行：文件应该从第 0 列开始`);
if (first && !first.text.startsWith("- ")) problems.push(`第 ${first.line} 行：顶层要是补丁列表，也就是以 "- " 开头`);
if (!rows.some((row) => /^- id: \S/.test(row.text))) problems.push("找不到 - id:，补丁条目没有标识");

/** 能拿到 YAML 解析器就真解析一遍；拿不到就只跑上面的结构检查。 */
let parsed = false;
try {
	const yaml = await import("js-yaml");
	const JsExpr = new yaml.Type("tag:yaml.org,2002:js", {
		kind: "scalar",
		construct: (value) => String(value)
	});
	const doc = yaml.load(text, { schema: yaml.DEFAULT_SCHEMA.extend([JsExpr]) });
	if (!Array.isArray(doc) || doc.length === 0) problems.push("解析结果不是非空的补丁列表");
	else if (!Array.isArray(doc[0]?.insert) || doc[0].insert.length === 0) problems.push("第一条补丁里没有 insert 列表");
	parsed = true;
} catch (error) {
	if (error && error.code === "ERR_MODULE_NOT_FOUND") {
		console.log("（没装 js-yaml，只做结构检查）");
	} else {
		problems.push(`YAML 解析失败：${error.message}`);
	}
}

if (problems.length > 0) {
	console.error("cordis.patch.yml 有问题：");
	for (const problem of problems) console.error(`  - ${problem}`);
	process.exitCode = 1;
} else {
	console.log(`cordis.patch.yml 结构正常${parsed ? "，YAML 解析通过" : ""}`);
}
