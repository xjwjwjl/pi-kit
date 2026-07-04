{
  "type": "pi-draw.scene",
  "version": 1,
  "source": "pi-draw",
  "kind": "mermaid",
  "title": "LLM Loop 流程图",
  "elements": [],
  "mermaid": {
    "definition": "flowchart TD\n    subgraph Input\n        A[\"用户输入 (Prompt)\"] --> B[\"Token 化 (Tokenizer)\"]\n    end\n\n    subgraph InferenceLoop[\"自回归生成循环\"]\n        B --> C[\"Transformer 前向传播\"]\n        C --> D[\"采样下一个 Token\"]\n        D --> E{\"是否为 EOS / 达到最大长度？\"}\n        E -- \"否\" --> F[\"追加 Token 到序列\"]\n        F --> C\n    end\n\n    subgraph Output\n        E -- \"是\" --> G[\"解码 Token → 文本\"]\n        G --> H[\"输出响应\"]\n    end\n\n    subgraph Feedback[\"反馈与优化\"]\n        H --> I[\"人工反馈 / RLHF\"]\n        I --> J[\"模型微调 / DPO\"]\n        J --> K[\"部署新模型版本\"]\n        K --> C\n    end\n\n    style A fill:#e1f5fe,stroke:#0288d1\n    style B fill:#e1f5fe,stroke:#0288d1\n    style C fill:#f3e5f5,stroke:#7b1fa2\n    style D fill:#f3e5f5,stroke:#7b1fa2\n    style E fill:#fff3e0,stroke:#f57c00\n    style F fill:#f3e5f5,stroke:#7b1fa2\n    style G fill:#e1f5fe,stroke:#0288d1\n    style H fill:#e8f5e9,stroke:#388e3c\n    style I fill:#fff8e1,stroke:#f9a825\n    style J fill:#fff8e1,stroke:#f9a825\n    style K fill:#fff8e1,stroke:#f9a825"
  },
  "createdAt": "2026-06-23T06:58:38.488Z",
  "updatedAt": "2026-06-23T06:58:38.488Z"
}
