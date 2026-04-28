import { z } from "zod";
import { definePrompt } from "../_shared/define-prompt.js";

const prompt = definePrompt({
  name: "comet_research_topic",
  title: "Research a topic with Perplexity (deep mode)",
  description: "Returns a turnkey workflow that creates a dedicated Comet task in research mode, asks the question, polls until it finishes, then closes the tab. Drop the returned messages into your assistant turn and it will execute the right tools in order.",
  arguments: [
    { name: "topic", description: "What to research.", required: true },
    { name: "depth", description: "search | research (default research)", required: false },
  ],
  inputSchema: {
    topic: z.string().min(1).describe("What to research."),
    depth: z.enum(["search", "research"]).default("research").describe("Perplexity mode to use."),
  },
  async get({ topic, depth }) {
    const text = [
      `You are about to research: "${topic}".`,
      "",
      "Execute these tools in order:",
      "",
      `1. comet_connect — { "label": "research:${topic.slice(0, 30)}", "keepAlive": true }`,
      "   Capture the returned task_id; use it for every call below.",
      "",
      `2. comet_mode — { "task_id": "<id>", "mode": "${depth}" }`,
      "",
      "3. comet_ask — {",
      `     "task_id": "<id>",`,
      `     "prompt": ${JSON.stringify(topic)},`,
      `     "newChat": true,`,
      `     "timeout": 60000`,
      "   }",
      "",
      "4. If the response from step 3 starts with 'Task ... still in progress' or",
      "   'Status: WORKING', poll until done:",
      `   comet_poll — { "task_id": "<id>" }`,
      "   Repeat with ~3s gaps until status is COMPLETED.",
      "",
      `5. comet_task_close — { "task_id": "<id>" }`,
      "",
      "Return the final response text to the user verbatim, then summarize the key",
      "findings in 3-5 bullets.",
    ].join("\n");
    return {
      description: `Comet research workflow for: ${topic}`,
      messages: [{ role: "user", content: { type: "text", text } }],
    };
  },
});

export default prompt;
