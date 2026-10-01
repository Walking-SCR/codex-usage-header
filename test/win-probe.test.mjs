import assert from 'node:assert/strict';
import { runProbe } from '../bin/win-probe.mjs';

console.log('Testing: Windows P0 feasibility probe module...');

// 运行探针（在非连接端口上验证安全降级、门槛结构与报告完整性）
const unusedPort = 65431;
const report = await runProbe({ port: unusedPort });

assert.ok(report, 'Probe must return a report object');
assert.ok(report.timestamp, 'Report must contain ISO timestamp');
assert.ok(report.os, 'Report must contain os details');
assert.equal(typeof report.os.nodeVersion, 'string');
assert.ok(report.gates, 'Report must contain gates object');

// 核验 6 大门槛是否完整定义
const requiredGates = [
  'environment',
  'packageDiscovery',
  'processInspection',
  'cdpPortSecurity',
  'webviewInjectability',
  'codexAppServer',
];

for (const gate of requiredGates) {
  assert.ok(gate in report.gates, `Gate '${gate}' must be present in report`);
  assert.equal(typeof report.gates[gate].pass, 'boolean', `Gate '${gate}.pass' must be boolean`);
  assert.ok(report.gates[gate].details !== undefined, `Gate '${gate}.details' must not be undefined`);
}

// 离线断言：当端口未启动时，必须判定为等待启动而不是误报通过或崩溃
assert.equal(report.gates.cdpPortSecurity.pass, false);
assert.equal(report.gates.webviewInjectability.pass, false);
assert.equal(report.verdict, 'WAITING_CDP_LAUNCH');
assert.ok(report.verdictMessage.includes('--remote-debugging-port'), 'Verdict message must instruct user to start with CDP flag');

console.log('✓ Windows P0 feasibility probe module tests passed!');
