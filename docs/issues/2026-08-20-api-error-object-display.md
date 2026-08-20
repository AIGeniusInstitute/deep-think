# 2026-08-20 - API 错误对象导致界面显示 `[object Object]`

## 1. 用户现象

前端 API 请求遇到 400、500、网络断开或超时时，部分页面不能显示后端返回的错误消息。例如 Docker 镜像构建请求失败后，监控页可能直接显示 `[object Object]`；供应商切换和成员管理等入口则会退化为通用错误提示。

## 2. 问题描述

`web/src/api/client.ts` 将 `ApiError` 声明为 TypeScript 接口，并在运行时抛出符合该接口形状的普通对象：

```ts
throw {
  status: res.status,
  message: body.error || res.statusText,
  body,
} as ApiError;
```

接口只参与静态类型检查，不会改变运行时对象。调用方普遍使用以下模式提取错误信息：

```ts
err instanceof Error ? err.message : String(err);
```

普通对象不属于 `Error`，因此进入 `String(err)` 分支并得到 `[object Object]`。依赖 `instanceof Error` 的其他调用方也无法读取已有的 `message`，只能显示通用兜底文案。

## 3. 根因

- `ApiError` 没有运行时构造函数和 `Error` 原型链。
- 超时、网络异常和非 2xx 响应均抛出对象字面量。
- 401 分支虽然抛出真正的 `Error`，但没有保留 HTTP `status`，与其他 API 错误的结构不一致。
- 普通对象没有标准错误栈，降低了日志和开发工具中的可诊断性。

## 4. 复现路径

1. 打开系统监控页并触发 Docker 镜像构建。
2. 让 `/api/docker/build` 返回非 2xx 响应，或断开网络。
3. `apiFetch` 抛出普通对象。
4. `web/src/stores/monitor.ts` 对该对象调用 `String(err)`。
5. `web/src/pages/MonitorPage.tsx` 将 `[object Object]` 渲染为构建错误。

同样的根因也会影响 MCP Server、Plugin、Skill 等使用统一 API client 和 `instanceof Error` 判断的页面。

## 5. 修复方案

将 `ApiError` 改为真正继承 `Error` 的类，并保留原有公开字段：

```ts
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
```

超时、网络异常、401 和其他非 2xx 响应统一抛出 `new ApiError(...)`。现有的 type-only import、`status/body/message` 结构读取以及 `instanceof Error` 判断均保持兼容，不需要批量修改 UI 或 store。

## 6. 验证

新增 `tests/api-client.test.ts`，覆盖：

- 400 和 500 响应保留 `status`、`message`、`body`，且同时属于 `Error` 和 `ApiError`。
- 网络异常映射为状态 0 和可读消息。
- 请求中止映射为状态 408 和超时消息。
- 401 保留状态并继续跳转登录页。
- 非 JSON 错误响应回退到 HTTP `statusText`。

建议执行：

```bash
npx vitest run tests/api-client.test.ts
make typecheck-web
npm --prefix web run build
```

## 7. 影响边界

修复仅改变统一 API client 创建错误的方式，不改变请求参数、响应解析、认证跳转或 UI 状态结构。成功响应路径不受影响。
