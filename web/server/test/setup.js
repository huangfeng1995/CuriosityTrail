'use strict';

/**
 * 测试引导文件。
 *
 * 由 `npm test` 用 `--require ./test/setup.js` 加载，
 * 父进程和每个测试子进程都会加载它（node 会把 execArgv 传给子进程）。
 *
 * **为什么要把 console.log 改道 stderr**
 *
 * node 的测试运行器起子进程跑测试文件时，子进程的 stdout 不是自由文本，
 * 而是一条**二进制帧流**：每帧以 `0xff 0x0f` 开头，后面跟长度和
 * V8 序列化后的数据。父进程按帧边界切分再反序列化。
 *
 * 应用代码在测试子进程里往 stdout 写一行明文（比如 database.js 的
 * 「数据库首次初始化」、auth.js 的「登录验证码」），如果这行明文正好
 * 插进某一帧的中间，父进程解帧就会失败：
 *
 *   Unable to deserialize cloned data due to invalid or unsupported version.
 *
 * 这个错算在**整个测试文件**头上——文件里所有用例一起被判失败，
 * 而且报错完全指不到真正的原因（应用只是打印了一行日志）。
 *
 * 所以测试期间把 console.log 改道 stderr：信息一条不少（父进程把
 * 子进程的 stderr 当注释行并进 TAP 输出），但不会再插进帧流。
 *
 * 注意：这是给测试运行环境的适配，不是改应用行为——
 * 正常跑服务时这些日志仍然走 stdout。
 */

console.log = console.error;
