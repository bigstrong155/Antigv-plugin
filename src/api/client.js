import tokenManager from '../auth/token_manager.js';
import config from '../config/config.js';

export async function generateAssistantResponse(requestBody, callback) {
  const token = await tokenManager.getToken();
  
  if (!token) {
    throw new Error('没有可用的token，请运行 npm run login 获取token');
  }
  
  const url = config.api.url;
  
  const requestHeaders = {
    'Host': config.api.host,
    'User-Agent': config.api.userAgent,
    'Authorization': `Bearer ${token.access_token}`,
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip'
  };
  
  let response;
  
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      const responseText = await response.text();
      
      if (response.status === 403) {
        tokenManager.disableCurrentToken(token);
        throw new Error(`该账号没有使用权限，已自动禁用。错误详情: ${responseText}`);
      }
      throw new Error(`API请求失败 (${response.status}): ${responseText}`);
    }
    
  } catch (error) {
    throw error;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let thinkingStarted = false;
  let toolCalls = [];

  let chunkCount = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    const chunk = decoder.decode(value);
    chunkCount++;
    const lines = chunk.split('\n').filter(line => line.startsWith('data: '));
    
    for (const line of lines) {
      const jsonStr = line.slice(6);
      try {
        const data = JSON.parse(jsonStr);
        
        const parts = data.response?.candidates?.[0]?.content?.parts;
        if (parts) {
          for (const part of parts) {
            if (part.thought === true) {
              if (!thinkingStarted) {
                callback({ type: 'thinking', content: '<think>\n' });
                thinkingStarted = true;
              }
              callback({ type: 'thinking', content: part.text || '' });
            } else if (part.text !== undefined) {
              // 过滤掉空的非thought文本
              if (part.text.trim() === '') {
                continue;
              }
              if (thinkingStarted) {
                callback({ type: 'thinking', content: '\n</think>\n' });
                thinkingStarted = false;
              }
              callback({ type: 'text', content: part.text });
            } else if (part.functionCall) {
              toolCalls.push({
                id: part.functionCall.id,
                type: 'function',
                function: {
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args)
                }
              });
            }
          }
        }
        
        // 当遇到 finishReason 时，发送所有收集的工具调用
        if (data.response?.candidates?.[0]?.finishReason && toolCalls.length > 0) {
          if (thinkingStarted) {
            callback({ type: 'thinking', content: '\n</think>\n' });
            thinkingStarted = false;
          }
          callback({ type: 'tool_calls', tool_calls: toolCalls });
          toolCalls = [];
        }
      } catch (e) {
        // 忽略解析错误
      }
    }
  }
}

export async function getAvailableModels() {
  const token = await tokenManager.getToken();
  
  if (!token) {
    throw new Error('没有可用的token，请运行 npm run login 获取token');
  }
  
  const modelsUrl = config.api.modelsUrl;
  
  const requestHeaders = {
    'Host': config.api.host,
    'User-Agent': config.api.userAgent,
    'Authorization': `Bearer ${token.access_token}`,
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip'
  };
  const requestBody = {};
  
  let response;
  let data;
  
  try {
    response = await fetch(modelsUrl, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(requestBody)
    });
    
    data = await response.json();
    
    if (!response.ok) {
      throw new Error(`获取模型列表失败 (${response.status}): ${JSON.stringify(data)}`);
    }
    
  } catch (error) {
    throw error;
  }
  
  return {
    object: 'list',
    data: Object.keys(data.models).map(id => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'google'
    }))
  };
}
