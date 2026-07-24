import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
    resolve(process.cwd(), "src/views/admin/moderation/ModerationRegions.vue"),
    "utf8",
);

describe("moderation regions DataList ownership", () => {
    it("delegates navigation row geometry and interaction states to FsusUI", () => {
        expect(source).toContain('variant="navigation"');
        expect(source).not.toMatch(/:deep\(\.el-data-list__/u);
        expect(source).toContain("--el-data-list-hover-background:");
        expect(source).toContain("--el-data-list-active-background:");
        expect(source).toContain("--el-data-list-focus-ring:");
        expect(source).toContain("--el-data-list-active-indicator:");
        expect(source).toContain(
            "color: var(--el-data-list-row-accent-color);",
        );
    });
});
