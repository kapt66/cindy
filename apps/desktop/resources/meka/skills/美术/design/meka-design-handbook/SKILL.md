---
description: MekaDesign design intent and structured handoff workflow
purpose: Read or change MekaDesign content and hand design intent to implementation
---

# MekaDesign handbook

Use MekaDesign when the target depends on design intent, structured design data, or a design-to-implementation handoff. Use only the Host-provided `meka_design` MCP tools for MekaDesign work. MCPRouter may provide other project tools, but it is not a second MekaDesign tool path. Never assume an endpoint or route identifier.

Before reading, identify the project and artifact requested. Before writing, inspect the current object, schema, references, and repository contract, then state the intended change and affected consumers. After writing, read the object back and validate the result. For handoff, record the design source, stable identifiers, fields and invariants, expected Unity or configuration consumers, and verification criteria. If the route is unavailable, report it as unavailable without substituting an unrelated project.
