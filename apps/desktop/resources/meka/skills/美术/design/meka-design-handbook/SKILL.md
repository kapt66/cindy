---
name: meka-design-handbook
description: 使用 MekaDesign 读取或修改设计内容，并把结构化设计意图可靠交接给实现侧。
metadata:
  display-name: MekaDesign 设计协作
  purpose: 处理 MekaDesign 内容和设计到实现的交接
---

# MekaDesign handbook

Use MekaDesign when the target depends on design intent, structured design data, or a design-to-implementation handoff. Use only the Host-provided `meka_design` MCP tools for MekaDesign work. MCPRouter may provide other project tools, but it is not a second MekaDesign tool path. Never assume an endpoint or route identifier.

Before reading, identify the project and artifact requested. Before writing, inspect the current object, schema, references, and repository contract, then state the intended change and affected consumers. After writing, read the object back and validate the result. For handoff, record the design source, stable identifiers, fields and invariants, expected Unity or configuration consumers, and verification criteria. If the route is unavailable, report it as unavailable without substituting an unrelated project.
