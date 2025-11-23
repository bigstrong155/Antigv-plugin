import { randomUUID } from 'crypto';
import config from '../config/config.js';
import logger from './logger.js';

function generateRequestId() {
  return `agent-${randomUUID()}`;
}

function generateSessionId() {
  return String(-Math.floor(Math.random() * 9e18));
}

function generateProjectId() {
  const adjectives = ['useful', 'bright', 'swift', 'calm', 'bold'];
  const nouns = ['fuze', 'wave', 'spark', 'flow', 'core'];
  const randomAdj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];
  const randomNum = Math.random().toString(36).substring(2, 7);
  return `${randomAdj}-${randomNoun}-${randomNum}`;
}
function extractImagesFromContent(content) {
  const result = { text: '', images: [] };

  // 如果content是字符串，直接返回
  if (typeof content === 'string') {
    result.text = content;
    return result;
  }

  // 如果content是数组（multimodal格式）
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text') {
        result.text += item.text;
      } else if (item.type === 'image_url') {
        // 提取base64图片数据
        const imageUrl = item.image_url?.url || '';

        // 匹配 data:image/{format};base64,{data} 格式
        const match = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (match) {
          const format = match[1]; // 例如 png, jpeg, jpg
          const base64Data = match[2];
          result.images.push({
            inlineData: {
              mimeType: `image/${format}`,
              data: base64Data
            }
          })
        }
      }
    }
  }

  return result;
}
function handleUserMessage(extracted, antigravityMessages, enableThinking){
  const parts = [];
  if (extracted.text) {
    // 在thinking模式下,文本部分需要添加thought标记以避免API错误
    if (enableThinking && extracted.images.length > 0) {
      parts.push({ text: extracted.text, thought: false });
    } else {
      parts.push({ text: extracted.text });
    }
  }
  parts.push(...extracted.images);
  
  // 确保parts数组不为空
  if (parts.length === 0) {
    parts.push({ text: "" });
  }
  
  antigravityMessages.push({
    role: "user",
    parts
  });
}
function handleAssistantMessage(message, antigravityMessages, isImageModel = false){
  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;
  const hasContent = message.content &&
    (typeof message.content === 'string' ? message.content.trim() !== '' : true);
  
  const antigravityTools = hasToolCalls ? message.tool_calls.map(toolCall => {
    let argsObj;
    try {
      argsObj = typeof toolCall.function.arguments === 'string'
        ? JSON.parse(toolCall.function.arguments)
        : toolCall.function.arguments;
    } catch (e) {
      argsObj = {};
    }
    
    return {
      functionCall: {
        id: toolCall.id,
        name: toolCall.function.name,
        args: argsObj
      }
    };
  }) : [];
  
  if (lastMessage?.role === "model" && hasToolCalls && !hasContent){
    lastMessage.parts.push(...antigravityTools)
  }else{
    const parts = [];
    if (hasContent) {
      let textContent = '';
      if (typeof message.content === 'string') {
        textContent = message.content;
      } else if (Array.isArray(message.content)) {
        textContent = message.content
          .filter(item => item.type === 'text')
          .map(item => item.text)
          .join('');
      }
      
      // 提取并处理 <think>...</think> 标签内容
      const thinkMatches = textContent.match(/<think>([\s\S]*?)<\/think>/g);
      if (thinkMatches) {
        for (const match of thinkMatches) {
          const thinkContent = match.replace(/<\/?think>/g, '').trim();
          if (thinkContent) {
            parts.push({ text: thinkContent, thought: true });
          }
        }
      }
      
      // 移除 <think>...</think> 标签及其内容，保留其他文本
      textContent = textContent.replace(/<think>[\s\S]*?<\/think>/g, '');
      
      // 如果是image模型，移除图片相关的markdown标记
      if (isImageModel) {
        textContent = textContent.replace(/!\[.*?\]\(data:image\/[^)]+\)/g, '');
        textContent = textContent.replace(/\[图像生成完成[^\]]*\]/g, '');
      }
      
      // 清理多余的空行
      textContent = textContent.replace(/\n{3,}/g, '\n\n').trim();
      
      if (textContent) {
        parts.push({ text: textContent });
      }
    }
    parts.push(...antigravityTools);
    
    if (parts.length === 0) {
      parts.push({ text: "" });
    }
    
    antigravityMessages.push({
      role: "model",
      parts
    })
  }
}
function handleToolCall(message, antigravityMessages){
  // 从之前的 model 消息中找到对应的 functionCall name
  let functionName = '';
  for (let i = antigravityMessages.length - 1; i >= 0; i--) {
    if (antigravityMessages[i].role === 'model') {
      const parts = antigravityMessages[i].parts;
      for (const part of parts) {
        if (part.functionCall && part.functionCall.id === message.tool_call_id) {
          functionName = part.functionCall.name;
          break;
        }
      }
      if (functionName) break;
    }
  }
  
  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const functionResponse = {
    functionResponse: {
      id: message.tool_call_id,
      name: functionName,
      response: {
        output: message.content
      }
    }
  };
  
  // 如果上一条消息是 user 且包含 functionResponse，则合并
  if (lastMessage?.role === "user" && lastMessage.parts.some(p => p.functionResponse)) {
    lastMessage.parts.push(functionResponse);
  } else {
    antigravityMessages.push({
      role: "user",
      parts: [functionResponse]
    });
  }
}
function openaiMessageToAntigravity(openaiMessages, enableThinking, isCompletionModel = false, modelName = ''){
  // 补全模型只需要最后一条用户消息作为提示
  if (isCompletionModel) {
    // 将所有消息合并为一个提示词
    let prompt = '';
    for (const message of openaiMessages) {
      if (message.role === 'system') {
        prompt += message.content + '\n\n';
      } else if (message.role === 'user') {
        prompt += message.content;
      } else if (message.role === 'assistant') {
        prompt += '\n' + message.content + '\n';
      }
    }
    
    return [{
      role: "user",
      parts: [{ text: prompt }]
    }];
  }
  
  const antigravityMessages = [];
  const isImageModel = modelName.endsWith('-image');
  
  for (const message of openaiMessages) {
    if (message.role === "user" || message.role === "system") {
      const extracted = extractImagesFromContent(message.content);
      handleUserMessage(extracted, antigravityMessages, enableThinking);
    } else if (message.role === "assistant") {
      handleAssistantMessage(message, antigravityMessages, isImageModel);
    } else if (message.role === "tool") {
      handleToolCall(message, antigravityMessages);
    }
  }
  
  return antigravityMessages;
}
function generateGenerationConfig(parameters, enableThinking, actualModelName, isNonChatModel = false){
  const generationConfig = {
    temperature: parameters.temperature ?? config.defaults.temperature,
    candidateCount: 1,
    maxOutputTokens: parameters.max_tokens ?? config.defaults.max_tokens
  };
  
  // 非对话模型使用最简配置
  if (isNonChatModel) {
    return generationConfig;
  }
  
  // 标准对话模型添加完整配置
  generationConfig.topP = parameters.top_p ?? config.defaults.top_p;
  generationConfig.topK = parameters.top_k ?? config.defaults.top_k;
  generationConfig.stopSequences = [
    "<|user|>",
    "<|bot|>",
    "<|context_request|>",
    "<|endoftext|>",
    "<|end_of_turn|>"
  ];
  
  // gemini-2.5-flash-image 不支持 thinkingConfig 参数
  if (actualModelName !== 'gemini-2.5-flash-image') {
    generationConfig.thinkingConfig = {
      includeThoughts: enableThinking,
      thinkingBudget: enableThinking ? 1024 : 0
    };
  }
  
  if (enableThinking && actualModelName.includes("claude")){
    delete generationConfig.topP;
  }
  
  return generationConfig;
}
function convertOpenAIToolsToAntigravity(openaiTools){
  if (!openaiTools || openaiTools.length === 0) return [];
  return openaiTools.map((tool)=>{
    delete tool.function.parameters.$schema;
    return {
      functionDeclarations: [
        {
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters
        }
      ]
    }
  })
}
function generateRequestBody(openaiMessages,modelName,parameters,openaiTools){
  const enableThinking = modelName.endsWith('-thinking') ||
    modelName === 'gemini-2.5-pro' ||
    modelName.startsWith('gemini-3-pro-') ||
    modelName === "rev19-uic3-1p" ||
    modelName === "gpt-oss-120b-medium"
  const actualModelName = modelName.endsWith('-thinking') ? modelName.slice(0, -9) : modelName;
  
  // 检测并拒绝不支持的模型类型
  const isChatModel = actualModelName.startsWith('chat_');  // chat_ 开头的内部补全模型
  
  if (isChatModel) {
    throw new Error(`Unsupported completion model: ${actualModelName}`);
  }
  
  // 标准对话模型使用标准格式
  const generationConfig = generateGenerationConfig(parameters, enableThinking, actualModelName, false);
  
  const requestBody = {
    project: generateProjectId(),
    requestId: generateRequestId(),
    request: {
      contents: openaiMessageToAntigravity(openaiMessages, enableThinking, false, actualModelName),
      generationConfig: generationConfig,
      sessionId: generateSessionId(),
      systemInstruction: {
        role: "user",
        parts: [{ text: config.systemInstruction }]
      }
    },
    model: actualModelName,
    userAgent: "antigravity"
  };
  
  if (openaiTools && openaiTools.length > 0) {
    requestBody.request.tools = convertOpenAIToolsToAntigravity(openaiTools);
    requestBody.request.toolConfig = {
      functionCallingConfig: {
        mode: "VALIDATED"
      }
    };
  }
  
  return requestBody;
}
export{
  generateRequestId,
  generateSessionId,
  generateProjectId,
  generateRequestBody
}
