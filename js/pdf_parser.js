export async function extractPdfText(file) {
  const pdfjsLib = await loadPdfJs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const rows = groupTextItemsByRow(content.items);
    pages.push({ pageNumber, rows });
  }

  return pages
    .map((page) => page.rows.map((row) => row.text).join("\n"))
    .join("\n\n");
}

export function parseItineraryText(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const legs = [];
  const warnings = [];
  let pendingLine = "";

  for (const line of lines) {
    const timePair = line.match(/(\d{1,2}[:時]\d{2})\D+(\d{1,2}[:時]\d{2})/u);
    const arrow = line.match(/(.+?)\s*(?:->|→|⇒|>|から|発)\s*(.+?)(?:\s|$)/u);
    const stationPair = line.match(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9]+駅?)\s*(?:-|–|ー|→|⇒|>|から)\s*([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9]+駅?)/u);

    if (/線|ライン|Line|新幹線|本線/u.test(line) && !stationPair) {
      pendingLine = line;
      continue;
    }

    const pair = stationPair || arrow;
    if (pair) {
      const from = cleanStation(pair[1]);
      const to = cleanStation(pair[2]);
      if (from && to && from !== to) {
        legs.push({
          leg_id: legs.length + 1,
          mode: "train",
          line_name: pendingLine,
          from_station: from,
          to_station: to,
          depart_time: normalizeTime(timePair?.[1] || ""),
          arrive_time: normalizeTime(timePair?.[2] || ""),
          notes: line
        });
        pendingLine = "";
      }
    }
  }

  if (!legs.length && lines.length) {
    warnings.push({
      message: "PDF 文本已提取，但没有识别出明确的乘车区间。可以在文本框中整理为“东京 -> 千叶 07:00 07:30”后再解析。"
    });
  }

  return {
    trip_title: "PDF 导入行程",
    source: "pdf-text",
    legs,
    warnings
  };
}

function groupTextItemsByRow(items) {
  const rows = [];
  for (const item of items) {
    const y = Math.round(item.transform?.[5] || 0);
    let row = rows.find((entry) => Math.abs(entry.y - y) < 3);
    if (!row) {
      row = { y, items: [] };
      rows.push(row);
    }
    row.items.push({
      x: item.transform?.[4] || 0,
      text: item.str || ""
    });
  }

  return rows
    .sort((a, b) => b.y - a.y)
    .map((row) => ({
      y: row.y,
      text: row.items
        .sort((a, b) => a.x - b.x)
        .map((item) => item.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    }))
    .filter((row) => row.text);
}

async function loadPdfJs() {
  if (globalThis.pdfjsLib) return globalThis.pdfjsLib;
  const pdfjsLib = await import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";
  return pdfjsLib;
}

function normalizeTime(value) {
  return String(value || "").replace("時", ":");
}

function cleanStation(value) {
  return String(value || "")
    .replace(/\d{1,2}[:時]\d{2}/g, "")
    .replace(/[発着]/g, "")
    .trim();
}
