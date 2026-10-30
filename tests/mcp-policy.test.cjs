'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {policy,allows,object}=require('../electron/mcp/policy.cjs');
test('MCP grants only explicit rights and hosts and rejects generic dispatch',()=>{
 const p=policy({hostIds:['one'],rights:['hosts','exec']});
 assert.equal(allows(p,'exec','one'),true);assert.equal(allows(p,'exec','two'),false);assert.equal(allows(p,'files:write','one'),false);
 assert.throws(()=>policy({hostIds:['one'],rights:['vault:read']}));
 assert.throws(()=>object({hostId:'one',password:'secret'},['hostId']));
});
