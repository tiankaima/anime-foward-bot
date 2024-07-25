import { ExecutionContext, KVNamespace } from '@cloudflare/workers-types/experimental';
import { TelegramAPI } from './telegram';

export interface Env {
	DATA: KVNamespace;
	ENV_BOT_TOKEN: string;
	ENV_BOT_SECRET: string;
	ENV_BOT_ADMIN_CHAT_ID: string;
}

async function set(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const key = url.searchParams.get('key');
	const value = url.searchParams.get('value');
	if (!key || !value) {
		return new Response('missing key or value', { status: 400 });
	}
	await env.DATA.put(key, value);
	return new Response('ok');
}

async function setWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	// auth
	const url = new URL(request.url);
	const secret = url.searchParams.get('secret');
	if (secret !== env.ENV_BOT_SECRET) {
		return new Response('invalid secret', { status: 403 });
	}

	const bot = new TelegramAPI({ botToken: env.ENV_BOT_TOKEN });
	const res = await bot.setWebhook({
		webhookUrl: `https://${new URL(request.url).hostname}/webhook`,
		webhookSecret: env.ENV_BOT_SECRET,
	});
	return new Response(res, { status: res ? 200 : 500 });
}

async function unsetWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	// auth
	const url = new URL(request.url);
	const secret = url.searchParams.get('secret');
	if (secret !== env.ENV_BOT_SECRET) {
		return new Response('invalid secret', { status: 403 });
	}

	const bot = new TelegramAPI({ botToken: env.ENV_BOT_TOKEN });
	const res = await bot.setWebhook({
		webhookUrl: '',
		webhookSecret: env.ENV_BOT_SECRET,
	});
	return new Response(res, {
		status: res ? 200 : 500,
		headers: {
			'content-type': 'application/json',
		},
	});
}

async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	// auth. this time check headers
	const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
	if (secret !== env.ENV_BOT_SECRET) {
		return new Response('invalid secret', { status: 403 });
	}

	const body = await request.json();
	console.log(JSON.stringify(body, null, 2));

	const bot = new TelegramAPI({ botToken: env.ENV_BOT_TOKEN });
	let res = await bot.sendMessage({
		chatId: env.ENV_BOT_ADMIN_CHAT_ID,
		text: JSON.stringify(body, null, 2),
	});
	console.log(res);
	return new Response('ok');
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const path = new URL(request.url).pathname;
		// if (path === '/set') {
		// 	return set(request, env, ctx);
		// }
		if (path === '/setWebhook') {
			return setWebhook(request, env, ctx);
		}
		if (path === '/unsetWebhook') {
			return unsetWebhook(request, env, ctx);
		}
		if (path === '/webhook') {
			return handleWebhook(request, env, ctx);
		}

		return new Response('not found', { status: 404 });

		// const keys = (await env.DATA.list()).keys;
		// const keys_str = JSON.stringify(keys);
		// return new Response(keys_str, {
		// 	headers: {
		// 		'content-type': 'application/json',
		// 	},
		// });
	},
};
