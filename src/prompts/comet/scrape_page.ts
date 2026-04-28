import { z } from "zod";
import { definePrompt } from "../_shared/define-prompt.js";

const prompt = definePrompt({
  name: "comet_scrape_page",
  title: "Scrape a page (no agent, just CDP)",
  description: "Returns a workflow that opens a fresh tab, navigates to the URL, captures structured data + a screenshot, and closes the tab. Uses comet_dom_query (or comet_eval if enabled) — does not invoke the Perplexity agent.",
  arguments: [
    { name: "url", description: "URL to scrape.", required: true },
    {
      name: "selector",
      description: "CSS selector to extract (default: 'h1, h2, p').",
      required: false,
    },
  ],
  inputSchema: {
    url: z.string().url().describe("URL to scrape."),
    selector: z.string().default("h1, h2, p").describe("CSS selector for the content to extract."),
  },
  async get({ url, selector }) {
    const text = [
      `You are about to scrape ${url} for elements matching: ${selector}`,
      "",
      "Execute these tools in order:",
      "",
      `1. comet_connect — { "label": "scrape" }`,
      "   Capture the returned task_id.",
      "",
      `2. comet_navigate — { "task_id": "<id>", "url": ${JSON.stringify(url)}, "waitForLoad": true }`,
      "",
      `3. comet_dom_query — { "task_id": "<id>", "selector": ${JSON.stringify(selector)}, "limit": 50 }`,
      "   This returns structured {tag, id, class, attrs, text, visible} per match.",
      "",
      `4. (optional) comet_full_screenshot — { "task_id": "<id>" }`,
      "   Attach the screenshot as evidence if useful.",
      "",
      `5. comet_task_close — { "task_id": "<id>" }`,
      "",
      "Present the scraped data as a markdown table or list, grouped by tag.",
      "If the page is heavy on JS-rendered content and step 3 returns nothing,",
      "wait 2s and call comet_dom_query again before giving up.",
    ].join("\n");
    return {
      description: `Comet scrape workflow for ${url}`,
      messages: [{ role: "user", content: { type: "text", text } }],
    };
  },
});

export default prompt;
