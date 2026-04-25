import { describe, expect, it } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

// Phase A wizard validation. The skill lives at
// .claude/skills/agents-md-wizard/. These tests guard the JSON shape and
// load-bearing invariants (every type asks the 3 universal questions, no
// duplicate ids within a file, all 8 type files exist).

const SKILL_DIR = join(import.meta.dir, "..", ".claude", "skills", "agents-md-wizard");
const QUESTIONS_DIR = join(SKILL_DIR, "questions");
const TEMPLATES_DIR = join(SKILL_DIR, "templates");

const EXPECTED_TYPES = [
  "business",
  "game",
  "research",
  "infra",
  "side-hustle",
  "personal-tool",
  "nonsense",
  "other",
];

const UNIVERSAL_QUESTION_IDS = ["what_is_this", "what_is_not", "when_done"];

interface WizardQuestion {
  id: string;
  prompt: string;
  required: boolean;
}

function loadQuestions(type: string): WizardQuestion[] {
  const path = join(QUESTIONS_DIR, `${type}.json`);
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw);
}

describe("agents-md-wizard skill structure", () => {
  it("SKILL.md exists with YAML frontmatter", () => {
    const skillMdPath = join(SKILL_DIR, "SKILL.md");
    expect(existsSync(skillMdPath)).toBe(true);
    const content = readFileSync(skillMdPath, "utf8");
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("name: agents-md-wizard");
    expect(content).toContain("description:");
  });

  it("templates/agents-md.md exists", () => {
    const templatePath = join(TEMPLATES_DIR, "agents-md.md");
    expect(existsSync(templatePath)).toBe(true);
  });

  it("README.md exists for the skill", () => {
    const readmePath = join(SKILL_DIR, "README.md");
    expect(existsSync(readmePath)).toBe(true);
  });
});

describe("agents-md-wizard question sets", () => {
  it("has a JSON file for every expected type", () => {
    for (const type of EXPECTED_TYPES) {
      const path = join(QUESTIONS_DIR, `${type}.json`);
      expect(existsSync(path)).toBe(true);
    }
  });

  it("has no unexpected JSON files in questions/", () => {
    const files = readdirSync(QUESTIONS_DIR).filter((f) => f.endsWith(".json"));
    const types = files.map((f) => f.replace(/\.json$/, "")).sort();
    expect(types).toEqual([...EXPECTED_TYPES].sort());
  });

  for (const type of EXPECTED_TYPES) {
    describe(`type: ${type}`, () => {
      it("parses as a JSON array", () => {
        const questions = loadQuestions(type);
        expect(Array.isArray(questions)).toBe(true);
      });

      it("every entry has id, prompt, required", () => {
        const questions = loadQuestions(type);
        for (const q of questions) {
          expect(typeof q.id).toBe("string");
          expect(q.id.length).toBeGreaterThan(0);
          expect(typeof q.prompt).toBe("string");
          expect(q.prompt.length).toBeGreaterThan(0);
          expect(typeof q.required).toBe("boolean");
        }
      });

      it("has no duplicate ids", () => {
        const questions = loadQuestions(type);
        const ids = questions.map((q) => q.id);
        const unique = new Set(ids);
        expect(unique.size).toBe(ids.length);
      });

      it("has no leading/trailing whitespace in ids", () => {
        const questions = loadQuestions(type);
        for (const q of questions) {
          expect(q.id).toBe(q.id.trim());
        }
      });
    });
  }

  it("nonsense type has exactly the 3 universal questions", () => {
    const questions = loadQuestions("nonsense");
    expect(questions.length).toBe(3);
    const ids = questions.map((q) => q.id);
    expect(ids).toEqual(UNIVERSAL_QUESTION_IDS);
  });

  it("other type has zero questions (free-text mode)", () => {
    const questions = loadQuestions("other");
    expect(questions.length).toBe(0);
  });

  it("every non-other type starts with the 3 universal questions in order", () => {
    for (const type of EXPECTED_TYPES) {
      if (type === "other") continue;
      const questions = loadQuestions(type);
      expect(questions.length).toBeGreaterThanOrEqual(3);
      const firstThreeIds = questions.slice(0, 3).map((q) => q.id);
      expect(firstThreeIds).toEqual(UNIVERSAL_QUESTION_IDS);
    }
  });

  it("universal questions are always required", () => {
    for (const type of EXPECTED_TYPES) {
      if (type === "other") continue;
      const questions = loadQuestions(type);
      for (const q of questions.slice(0, 3)) {
        expect(q.required).toBe(true);
      }
    }
  });

  it("type counts match the documented heavy/focused/light shape", () => {
    // Heavy: business 12, game 10
    expect(loadQuestions("business").length).toBe(12);
    expect(loadQuestions("game").length).toBe(10);
    // Focused: research 6, infra 7
    expect(loadQuestions("research").length).toBe(6);
    expect(loadQuestions("infra").length).toBe(7);
    // Light: side-hustle 6, personal-tool 5, nonsense 3
    expect(loadQuestions("side-hustle").length).toBe(6);
    expect(loadQuestions("personal-tool").length).toBe(5);
    expect(loadQuestions("nonsense").length).toBe(3);
  });
});

describe("agents-md template", () => {
  it("contains the 10 standard sections", () => {
    const template = readFileSync(join(TEMPLATES_DIR, "agents-md.md"), "utf8");
    for (let i = 1; i <= 10; i++) {
      expect(template).toContain(`## ${i}.`);
    }
  });

  it("references the universal-question placeholders directly", () => {
    const template = readFileSync(join(TEMPLATES_DIR, "agents-md.md"), "utf8");
    expect(template).toContain("answers.what_is_this");
    expect(template).toContain("answers.what_is_not");
    expect(template).toContain("answers.when_done");
  });

  it("uses fallback chains so light types render with universals only", () => {
    const template = readFileSync(join(TEMPLATES_DIR, "agents-md.md"), "utf8");
    expect(template).toContain("||");
    expect(template).toContain("[not specified]");
  });

  it("references the AGENTS.md spec URL", () => {
    const template = readFileSync(join(TEMPLATES_DIR, "agents-md.md"), "utf8");
    expect(template).toContain("https://agents.md");
  });
});
