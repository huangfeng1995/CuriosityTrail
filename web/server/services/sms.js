'use strict';

/**
 * 阿里云短信发送。
 *
 * 只发一种短信：登录验证码。按阿里云 RPC 签名规范直接实现，
 * 不引入 aliyun-sdk——整套 SDK 只为一个 SendSms 请求太重了。
 *
 * 密钥只从环境变量读取，不写库、不写日志。
 */

const crypto = require('crypto');
const config = require('../config');

const ENDPOINT = 'https://dysmsapi.aliyuncs.com/';
const API_VERSION = '2017-05-25';
const REGION_ID = 'cn-hangzhou';

/**
 * 阿里云要求的百分号编码：在 encodeURIComponent 基础上处理三个特例字符。
 * @param {string} value
 * @returns {string}
 */
function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

/**
 * 计算 RPC 签名。
 * @param {Record<string, string>} params 业务参数
 * @returns {string} Base64 签名
 */
function signParams(params) {
  const canonical = Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&');

  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonical)}`;
  return crypto
    .createHmac('sha1', `${config.aliyunSmsAccessKeySecret}&`)
    .update(stringToSign)
    .digest('base64');
}

/**
 * 发送登录取证码短信。
 * @param {string} phone 11 位手机号
 * @param {string} code 6 位验证码
 * @returns {Promise<void>}
 */
async function sendLoginCode(phone, code) {
  if (!config.smsConfigured) {
    const err = new Error('短信服务未配置，请联系管理员');
    err.status = 503;
    throw err;
  }

  const params = {
    AccessKeyId: config.aliyunSmsAccessKeyId,
    Action: 'SendSms',
    Format: 'JSON',
    PhoneNumbers: phone,
    RegionId: REGION_ID,
    SignName: config.aliyunSmsSignName,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    TemplateCode: config.aliyunSmsTemplateCode,
    TemplateParam: JSON.stringify({ code }),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: API_VERSION,
  };
  params.Signature = signParams(params);

  const query = Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&');

  let response;
  try {
    response = await fetch(`${ENDPOINT}?${query}`, {
      method: 'GET',
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    const err = new Error('短信发送失败，请稍后重试');
    err.status = 502;
    throw err;
  }

  let body = {};
  try {
    body = await response.json();
  } catch (e) {
    // 非 JSON 响应按失败处理
  }

  if (body.Code !== 'OK') {
    console.error(`阿里云短信发送失败：${body.Code || response.status} ${body.Message || ''}`);
    const err = new Error('短信发送失败，请稍后重试');
    err.status = 502;
    throw err;
  }
}

module.exports = { sendLoginCode };
