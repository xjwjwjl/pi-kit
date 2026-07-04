# pi-ask-user

A lightweight, fast ask-user tool for pi — ask the user structured follow-up questions without the bloat.

Combines `question.ts`' inline custom answer flow with `questionnaire.ts`' multi-question tabs. Designed to be quick to render and easy to maintain.

## Install

```bash
pi install ./extensions/ask
```

Or copy to extensions directory for auto-discovery:

```bash
cp ask_user.ts ~/.pi/agent/extensions/
```

## Supported question types

- `text`: free-text answer (auto-enables custom input)
- `single`: choose exactly one option from a list
- `multi`: select multiple options with Space toggle

## Features

- **Multi-question tabs** — group up to 5 questions in one call with Tab/←→ navigation
- **Submit tab** — review all answers before submitting
- **Custom answers** — `Type something.` for free-text input on any choice question (`allowCustom: true`, default on)
- **Answer prefill** — revisiting a question shows the previous answer
- **Compact rendering** — no markdown engine, no overlay, just inline TUI

## Constraints

- 1–5 questions per call
- 2–5 options per choice question when fixed options are provided
- Label length limits enforced in schema and runtime validation
- Reserved labels (`Other`, `Type something.`, `Chat about this`, `Next →`) rejected

## Usage notes

- `ask_user` is for collecting user input needed to continue the main task.
- It is not meant for quizzes or long-form teaching flows.
- For `text` questions, omit `options` entirely; a compatibility shim drops accidental empty `options: []` and any `options` attached to `kind: "text"` before schema validation.
- For `multi` questions, `Type something.` stores a single typed custom value that can be reopened and edited.
- Revisiting a question shows the previous answer and prefills the editor when reopening typed input.
- The model is instructed to batch related questions into one call and avoid back-to-back `ask_user` invocations.

## Example

```ts
{
  title: "Ask about website setup",
  questions: [
    {
      id: "deploy",
      label: "上线方式",
      prompt: "你希望网站如何上线？",
      kind: "single",
      options: [
        { value: "local", label: "暂时只想本地做出来" },
        { value: "platform", label: "部署到 GitHub Pages / Netlify / Vercel" },
        { value: "server", label: "部署到自己的服务器" },
      ],
      allowCustom: true,
    },
    {
      id: "notes",
      label: "补充",
      prompt: "还有什么需要提前说明的？",
      kind: "text",
    },
  ],
}
```

## Result shape

- `content[0].text`: text summary for the model
- `details.questions`: normalized question objects
- `details.answers`: structured answer array
- `details.cancelled`: whether the user cancelled
- `details.error`: validation or runtime error, if any
