import { DefineFunction, Schema, SlackFunction } from "deno-slack-sdk/mod.ts";
import { SlackAPIClient } from "deno-slack-sdk/types.ts";
import { isDebugMode } from "./internals/debug_mode.ts";

export const def = DefineFunction({
  callback_id: "translate_using_openai",
  title: "Translate message using OpenAI and post as a reply in its thread",
  source_file: "functions/translate_using_openai.ts",
  input_parameters: {
    properties: {
      channelId: { type: Schema.types.string },
      messageTs: { type: Schema.types.string },
      lang: { type: Schema.types.string },
    },
    required: ["channelId", "messageTs", "lang"], // Ensure 'lang' is now a required input
  },
  output_parameters: {
    properties: { ts: { type: Schema.types.string } },
    required: [],
  },
});

export default SlackFunction(def, async ({ inputs, client, env }) => {
  const debugMode = isDebugMode(env);
  const apiKey = env.OPENAI_API_KEY; // Ensure the API key is available
  if (!apiKey) {
    return { error: "OpenAI API key is not set. Please configure it properly." };
  }

  // Fetch the target message to translate
  const msgResponse = await client.conversations.replies({
    channel: inputs.channelId,
    ts: inputs.messageTs,
    limit: 1,
    inclusive: true,
  });

  if (msgResponse.messages.length == 0) {
    console.log("No message found for translation.");
    return { outputs: {} };
  }
  const targetText = msgResponse.messages[0].text;

  // Prepare the OpenAI API call
  const translationPrompt = `Translate this to ${inputs.lang}: ${targetText}`;
  console.log(`Sending translation request to OpenAI: ${JSON.stringify({
      model: "gpt-4",
      prompt: translationPrompt,
      max_tokens: 1024,
      temperature: 0.5
  })}`);
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4",
      prompt: translationPrompt,
      max_tokens: 1024,
      temperature: 0.5,
    }),
  });

  if (!response.ok) {
    const error = `Failed to translate message: ${await response.text()}`;
    console.log(error);
    return { error };
  }

  const { choices } = await response.json();
  if (choices.length === 0 || !choices[0].text) {
    return { outputs: {} };
  }
  const translatedText = choices[0].text.trim();

  // Post the translation back to the Slack thread
  console.log(`Sending post message request to Slack: ${JSON.stringify({
      channel: inputs.channelId,
      text: translatedText,
      thread_ts: inputs.messageTs
  })}`);
  const result = await client.chat.postMessage({
    channel: inputs.channelId,
    text: translatedText,
    thread_ts: inputs.messageTs,
  });

  return { outputs: { ts: result.ts } };
});
