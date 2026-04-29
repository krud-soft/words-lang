# WORDS Parser Grammar

This file describes the grammar shape implemented by the hand-written parser.
It is intentionally EBNF-like rather than a generator input. The parser remains
recursive descent so it can keep partial AST recovery and precise token ranges
for the LSP.

## Lexical Conventions

```ebnf
PascalIdent = construct or type name
CamelIdent  = prop, argument, method, callback, or local binding name
Description = StringLit
Trivia      = Newline | Comment
```

The lexer normalises `is not` into one `IsNot` token. Comments and newlines are
preserved in the token stream; grammar rules skip them unless line boundaries
are meaningful.

## Document

```ebnf
Document =
  OwnershipDecl? TopLevel*

OwnershipDecl =
  "module" PascalIdent Newline

TopLevel =
  SystemDecl
  | ModuleDecl
  | StateDecl
  | ContextDecl
  | ScreenDecl
  | ViewDecl
  | ProviderDecl
  | AdapterDecl
  | InterfaceDecl
```

## System And Module

```ebnf
SystemDecl =
  "system" PascalIdent Description? "(" SystemBody ")"

SystemBody =
  ModulesBlock? SystemInterfaceBlock?

ModulesBlock =
  "modules" "(" PascalIdent* ")"

SystemInterfaceBlock =
  "interface" "(" MethodDecl* ")"

ModuleDecl =
  "module" PascalIdent Description? "(" ModuleBody ")"

ModuleBody =
  (ProcessDecl | StartDecl | ImplementsDecl | InterfaceDecl | SystemCall)*

StartDecl =
  "start" PascalIdent
```

## Process And Implements

```ebnf
ProcessDecl =
  "process" PascalIdent Description? "(" WhenRule* ")"

WhenRule =
  "when" PascalIdent "returns" PascalIdent "enter" PascalIdent Description? InlineContext?

InlineContext =
  "(" ArgumentList? ")"

ImplementsDecl =
  "implements" QualifiedName "(" ImplementsBody ")"

ImplementsBody =
  ImplementsHandlerBody | ImplementsCallbackBody

ImplementsHandlerBody =
  CamelIdent CamelIdent "(" Type ")" "(" ImplementsBranch* ")"

ImplementsBranch =
  "if" Condition "enter" PascalIdent Description?

ImplementsCallbackBody =
  CamelIdent "is" "(" ImplementsEnterAction* ")"

ImplementsEnterAction =
  "enter" PascalIdent ("context" "is" PascalIdent)? InlineContext?
```

## Behavioral Constructs

```ebnf
StateDecl =
  "state" PascalIdent Description? ReceivesClause? "(" StateBody ")"

ReceivesClause =
  "receives" "?"? PascalIdent

StateBody =
  (ReturnsClause | UsesClause)*

ReturnsClause =
  "returns" SimpleReturns
  | "returns" ExpandedReturns

SimpleReturns =
  PascalIdent ("," PascalIdent)*

ExpandedReturns =
  "(" ExpandedReturn* ")"

ExpandedReturn =
  PascalIdent "(" SideEffect* ")"

SideEffect =
  SystemCall

ContextDecl =
  "context" PascalIdent Description? "(" PropList? ")"
```

## Component Constructs

```ebnf
ScreenDecl =
  "screen" PascalIdent Description? "(" UsesClause* ")"

ViewDecl =
  "view" PascalIdent Description? "(" ComponentBody ")"

ProviderDecl =
  "provider" PascalIdent Description? "(" ProviderAdapterBody ")"

AdapterDecl =
  "adapter" PascalIdent Description? "(" ProviderAdapterBody ")"

InterfaceDecl =
  "interface" PascalIdent? IncludesClause? Description? "(" InterfaceBody ")"

IncludesClause =
  "includes" QualifiedName ("," QualifiedName)*

ComponentBody =
  PropsBlock? StateBlock? UsesClause?

ProviderAdapterBody =
  PropsBlock? StateBlock? InterfaceMethodBlock?

InterfaceBody =
  PropsBlock? StateBlock? UsesClause? MethodDecl*

PropsBlock =
  "props" "(" PropList? ")"

StateBlock =
  "state" "(" PropList? ")"

InterfaceMethodBlock =
  "interface" "(" MethodDecl* ")"
```

## Uses

```ebnf
UsesClause =
  "uses" UseEntry
  | "uses" "(" UseEntryList? ")"

UseEntryList =
  UseEntry (","? UseEntry)*

UseEntry =
  ComponentUse
  | ConditionalBlock
  | IterationBlock
  | SystemCall

ComponentUse =
  ComponentKind QualifiedName ComponentUseBody?

ComponentKind =
  "screen" | "view" | "adapter" | "provider" | "interface"

ComponentUseBody =
  "(" (ArgumentList | UsesClause | UseEntry)* ")"

ConditionalBlock =
  "if" Condition "(" UseEntryList? ")"

IterationBlock =
  "for" AccessExpression "as" CamelIdent ("," CamelIdent)? "(" UseEntryList? ")"
```

## Declarations

```ebnf
PropList =
  PropDecl ("," PropDecl)*

PropDecl =
  "?"? CamelIdent TypeAnnotation? DefaultValue?
  | CamelIdent CamelIdent "(" Type? ")"
  | CamelIdent

TypeAnnotation =
  "(" Type ")"

Type =
  "?"? PrimitiveType
  | "?"? PascalIdent
  | "list" "(" Type ")"
  | "map" "(" Type "," Type ")"

PrimitiveType =
  "string" | "integer" | "float" | "boolean" | "context"

DefaultValue =
  "is" Literal

MethodDecl =
  CamelIdent MethodParam* ReturnsType? Description?

MethodParam =
  CamelIdent "(" Type ")"
  | "context" "is" PascalIdent

ReturnsType =
  "returns" "(" Type ")"
```

## Expressions

```ebnf
ArgumentList =
  Argument ("," Argument)*

InlineArgumentList =
  Argument ("," Argument)*

Argument =
  CamelIdent "is" Expression

Expression =
  BlockExpression
  | StateReturnExpression
  | CallExpression
  | AccessExpression
  | PascalIdent
  | Literal

BlockExpression =
  "(" Statement* ")"

Statement =
  StateReturnStatement
  | AssignmentStatement

StateReturnStatement =
  "state" "." "return" PascalIdent InlineContext?
  | "state" "." "return" "(" "value" "is" AccessExpression ")"
  | "state" "." "return" "(" Identifier ")"

AssignmentStatement =
  "state" "." CamelIdent "is" Expression

Condition =
  AccessExpression ("is" | "is not") Expression

SystemCall =
  AccessExpression ("(" (ArgumentList | PascalIdent)? ")" | InlineArgumentList)?

CallExpression =
  AccessExpression "(" ArgumentList? ")"

AccessExpression =
  Identifier ("." Identifier)*

QualifiedName =
  Identifier ("." Identifier)*

Identifier =
  PascalIdent | CamelIdent | keyword-as-expression-root

keyword-as-expression-root =
  "context" | "props" | "state" | "system"

Literal =
  StringLit | IntegerLit | FloatLit | BooleanLit | "[]" | "{}"
```

## Recovery Notes

The parser reports diagnostics instead of throwing. When a construct cannot
continue, it synchronises at a top-level keyword, `)`, or EOF. Smaller rules
prefer local recovery so callers can still produce a partial AST.
