// Writes test/fixtures/Line Breaks.pdf: a small PDF whose phrases break across lines and
// across a page, the way typeset books do. Run with `node scripts/make-fixture-pdf.mjs`.
// Each string below is one line of text on its page; pdftotext gives one line per string.
import { writeFileSync } from "node:fs";

const pages = [
	["A short opening page about method.", "Nothing here runs on."],
	[
		"More than once during my research I realised I had",
		"essentially wasted an",
		"interview by arguing my own thesis.",
		"It’s a lesson about the covenant of",
	],
	["grace and how it is kept.", "The end."],
	[
		// pdftotext rejoins a word hyphenated within a paragraph like this one itself. Words it
		// leaves split (a soft hyphen or U+2010 between blocks it reads separately, as in many
		// typeset books) are covered by the unit tests on recorded rga output.
		"A hyphen at a line break: the second inter-",
		"view went better than the first.",
		"Covenant one,",
		"covenant two,",
		"covenant three.",
	],
];

const objects = [];
const add = (body) => objects.push(body) && objects.length;
// WinAnsiEncoding, so 0x92 is a curly apostrophe.
const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
/** Text as WinAnsi bytes (written as latin1 below): the curly apostrophe is 0x92 there. */
const winAnsi = (s) => s.replace(/’/g, "\x92");
const pagesId = 2 + pages.length * 2;
const kids = [];
for (const lines of pages) {
	const text = lines.map((l, i) => `${i ? "0 -24 Td " : ""}(${winAnsi(l).replace(/[()\\]/g, "\\$&")}) Tj`).join(" ");
	const stream = `BT /F1 14 Tf 72 720 Td ${text} ET`;
	const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
	kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
}
if (add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`) !== pagesId) throw new Error("object numbering");
const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

let out = "%PDF-1.4\n";
const offsets = objects.map((body, i) => {
	const at = out.length;
	out += `${i + 1} 0 obj\n${body}\nendobj\n`;
	return at;
});
const xref = out.length;
out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync("test/fixtures/Line Breaks.pdf", out, "latin1");
console.log("Wrote test/fixtures/Line Breaks.pdf");
