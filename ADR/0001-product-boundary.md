# ADR-0001：产品边界

状态：**FROZEN**

Relay 是面向软件项目、独立运行、以证据为门禁的自治运行时。它拥有 Goal、Work、Policy、执行协调、Recovery 和 Audit。ChatGPT 只是可选 Client。

它不拥有通用助手 UI、模型市场、浏览器产品、向量存储或领域专属产品工作流。领域方法以 Pack 的形式被 Runtime 消费。

该边界避免 Relay 围绕每种工具和方法论再次形成一个庞大操作系统。
