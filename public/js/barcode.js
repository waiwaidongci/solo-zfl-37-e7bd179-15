// Code39 条码生成（无字体依赖，输出 SVG）。支持 A-Z 0-9 - . * $ / + % 空格。
const PATTERNS = {
  "0": "nnnwwnwnn", "1": "wnnwnnnnw", "2": "nnwwnnnnw", "3": "wnwwnnnnn",
  "4": "nnnwwnnnw", "5": "wnnwwnnnn", "6": "nnwwwnnnn", "7": "nnnwnnwnw",
  "8": "wnnwnnwnn", "9": "nnwwnnwnn", "A": "wnnnnwnnw", "B": "nnwnnwnnw",
  "C": "wnwnnwnnn", "D": "nnnnwwnnw", "E": "wnnnwwnnn", "F": "nnwnwwnnn",
  "G": "nnnnnwwnw", "H": "wnnnnwwnn", "I": "nnwnnwwnn", "J": "nnnnwwwnn",
  "K": "wnnnnnnww", "L": "nnwnnnnww", "M": "wnwnnnnwn", "N": "nnnnwnnww",
  "O": "wnnnwnnwn", "P": "nnwnwnnwn", "Q": "nnnnnnwww", "R": "wnnnnnwwn",
  "S": "nnwnnnwwn", "T": "nnnnwnwwn", "U": "wwnnnnnnw", "V": "nwwnnnnnw",
  "W": "wwwnnnnnn", "X": "nwnnwnnnw", "Y": "wwnnwnnnn", "Z": "nwwnwnnnn",
  "-": "nwnnnnwnw", ".": "wwnnnnwnn", " ": "nwwnnnwnn", "$": "nwnwnwnnn",
  "/": "nwnwnnnwn", "+": "nwnnnwnwn", "%": "nnnwnwnwn", "*": "nwnnwnwnn",
};

function patternToBars(pattern) {
  // n=窄 w=宽；奇数位是条，偶数位是空
  const units = [];
  for (let i = 0; i < pattern.length; i++) {
    units.push({ width: pattern[i] === "w" ? 3 : 1, dark: i % 2 === 0 });
  }
  return units;
}

export function code39Svg(text, { height = 56 } = {}) {
  const src = "*" + String(text).toUpperCase() + "*";
  const narrow = 2; // 窄条像素宽
  let x = 0;
  const rects = [];
  for (let ci = 0; ci < src.length; ci++) {
    const pat = PATTERNS[src[ci]];
    if (!pat) return "";
    for (const u of patternToBars(pat)) {
      const w = u.width * narrow;
      if (u.dark) rects.push(`<rect x="${x}" y="0" width="${w}" height="${height}" fill="#000"/>`);
      x += w;
    }
    x += narrow; // 字符间窄空
  }
  return `<svg viewBox="0 0 ${x} ${height}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">${rects.join("")}</svg>`;
}
