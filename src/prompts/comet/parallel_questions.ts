import { z } from "zod";
import { definePrompt } from "../_shared/define-prompt.js";

const prompt = definePrompt({
  name: "comet_parallel_questions",
  title: "Ask N questions in parallel (one task each)",
  description: "Returns a workflow that fans out one Comet task per question, runs them concurrently, then collects the answers and tears down every tab. Use when the questions are independent — they share no chat history.",
  arguments: [
    { name: "questions", description: "Newline-separated list of questions.", required: true },
  ],
  inputSchema: {
    questions: z.string().min(1).describe("Newline-separated list of questions to ask in parallel."),
  },
  async get({ questions }) {
    const list = questions
      .split(/\r?\n/)
      .map((q) => q.trim())
      .filter(Boolean);
    if (list.length === 0) {
      return {
        description: "No questions provided",
        messages: [{ role: "user", content: { type: "text", text: "No questions to run." } }],
      };
    }
    const lines: string[] = [];
    lines.push(`You are about to ask ${list.length} independent question(s) in parallel.`);
    lines.push("");
    lines.push("Step 1 — fan out connects (issue these in parallel):");
    list.forEach((q, i) => {
      lines.push(`  comet_connect — { "label": "q${i + 1}" }`);
      lines.push(`  Capture the returned task_id as id_${i + 1}.`);
    });
    lines.push("");
    lines.push("Step 2 — fan out asks in parallel (one task_id per ask):");
    list.forEach((q, i) => {
      lines.push(
        `  comet_ask — { "task_id": "<id_${i + 1}>", "prompt": ${JSON.stringify(q)}, "newChat": true, "timeout": 90000 }`,
      );
    });
    lines.push("");
    lines.push("Each comet_ask runs in its own Comet tab — they do not share state.");
    lines.push("Completed one-shot asks self-clean by default. Add closeAfter=false if you need to inspect or continue a tab.");
    lines.push("");
    lines.push("Step 3 — present the answers as a numbered list, one per question.");
    lines.push("If any task returns 'still in progress', poll with comet_poll task_id=… every 3s.");
    return {
      description: `Comet parallel-questions workflow (${list.length} tasks)`,
      messages: [{ role: "user", content: { type: "text", text: lines.join("\n") } }],
    };
  },
});

export default prompt;
