import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const privacyPagePath = fileURLToPath(new URL("../public/privacy.html", import.meta.url));

describe("packaged page-collaboration privacy page", () => {
  it("is a self-contained disclosure-v1 document with the complete data inventory", async () => {
    const source = await readFile(privacyPagePath, "utf8");

    expect(source).toContain("页面协作披露版本 1");
    expect(source).toContain("精确网站");
    expect(source).toContain("服务器配置");
    expect(source).toContain("逻辑标签页标识");
    expect(source).toContain("量化坐标");
    expect(source).toContain("页面兼容性摘要");
    expect(source).toContain("已识别媒体状态");
    expect(source).toContain("你主动发送的弹幕");
    expect(source).toContain("你主动创建的画笔内容");
    expect(source).toContain("Cookie");
    expect(source).toContain("密码");
    expect(source).toContain("表单输入");
    expect(source).toContain("页面文字");
    expect(source).toContain("DOM");
    expect(source).toContain("截图");
    expect(source).toContain("视频流");
    expect(source).toContain("浏览历史");
    expect(source).toContain("无关标签页");
    expect(source).toContain("页面内容与对方不同时");
    expect(source).toContain("已授权站点");

    expect(source).not.toMatch(/<script\b/iu);
    expect(source).not.toMatch(/<form\b/iu);
    expect(source).not.toMatch(/<(?:img|iframe|video|audio)\b/iu);
    expect(source).not.toMatch(/<link\b/iu);
    expect(source).not.toMatch(/\b(?:src|href)\s*=\s*["']https?:/iu);
    expect(source).not.toMatch(/analytics|telemetry|beacon|pixel/iu);
  });
});
