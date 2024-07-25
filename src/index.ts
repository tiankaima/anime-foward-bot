import { ExecutionContext, KVNamespace, ScheduledController } from '@cloudflare/workers-types/experimental';
import { TelegramAPI } from './telegram';
import { fetchRecentPosts } from './search';

interface Env {
	DATA: KVNamespace;
	ENV_BOT_TOKEN: string;
	ENV_BOT_SECRET: string; // TODO: currently used both for API auth and webhook auth. Refactor this.
	ENV_BOT_ADMIN_CHAT_ID: string;
}

interface Rule {
	id: number;
	useRegex: boolean;
	regex: string | null; // full match
	keywords: string[] | null; // all keywords must be present
}

interface RuleStorage {
	data: Map<string, Rule[]>;
}

function matchRule(rule: Rule, text: string): boolean {
	if (rule.useRegex) {
		const regex = new RegExp(rule.regex as string);
		return regex.test(text);
	} else if (rule.keywords) {
		return rule.keywords.every((keyword) => text.includes(keyword));
	}
	return false;
}

function matchRules(rules: Rule[], text: string): boolean {
	return rules.some((rule) => matchRule(rule, text));
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

async function handleMessageText(env: Env, chatId: string, text: string): Promise<void> {
	// /add_regex_rule <regex>
	// /add_keyword_rule <keyword1> <keyword2> ...
	// /list_rules
	// /remove_rule <id>
	// /fetch_now <length=%d(default 7)>

	const bot = new TelegramAPI({ botToken: env.ENV_BOT_TOKEN });

	const parts = text.split(' ');
	if (
		parts.length == 0 ||
		(parts.length < 2 && !['/list_rules', '/fetch_now', '/start', '/help'].includes(parts[0])) ||
		parts[0][0] !== '/'
	) {
		await bot.sendMessage({
			chatId,
			text: 'invalid command',
		});
		return;
	}

	let command = parts[0];
	if (command.includes('@')) {
		command = command.split('@')[0];
	}
	const args = parts.slice(1);

	if (command === '/start') {
		await bot.sendMessage({
			chatId,
			text: 'welcome! use /help to get help',
		});
		return;
	}

	if (command === '/help') {
		await bot.sendMessage({
			chatId,
			text: `
/add_regex_rule <regex>
/add_keyword_rule <keyword1> <keyword2> ...
/list_rules
/remove_rule <id>
/fetch_now <length=%d(default 7)>`,
		});
		return;
	}

	const rulestorage = (await env.DATA.get('rules').then((r) => (r ? JSON.parse(r) : { data: {} }))) as RuleStorage;

	if (command === '/add_regex_rule') {
		const regex = args.join(' ').trim();

		if (regex === '') {
			await bot.sendMessage({
				chatId,
				text: 'invalid regex',
			});
			return;
		}

		const rule: Rule = {
			id: Math.floor(Math.random() * 1000000),
			useRegex: true,
			regex,
			keywords: null,
		};
		if (!rulestorage.data[chatId]) {
			rulestorage.data[chatId] = [];
		}
		rulestorage.data[chatId].push(rule);
		await env.DATA.put('rules', JSON.stringify(rulestorage));
		await bot.sendMessage({
			chatId,
			text: `rule added: ${rule.id}`,
		});
		return;
	}

	if (command === '/add_keyword_rule') {
		const keywords = args;

		if (keywords.length === 0) {
			await bot.sendMessage({
				chatId,
				text: 'invalid keywords',
			});
			return;
		}

		const rule: Rule = {
			id: Math.floor(Math.random() * 1000000),
			useRegex: false,
			regex: null,
			keywords,
		};
		if (!rulestorage.data[chatId]) {
			rulestorage.data[chatId] = [];
		}
		rulestorage.data[chatId].push(rule);
		await env.DATA.put('rules', JSON.stringify(rulestorage));
		await bot.sendMessage({
			chatId,
			text: `rule added: ${rule.id}`,
		});
		return;
	}

	if (command === '/list_rules') {
		const rules = rulestorage.data[chatId] || [];
		const message = rules.map((rule) => {
			if (rule.useRegex) {
				return `#\`${rule.id}\` (regex): ${rule.regex}`;
			}
			if (rule.keywords) {
				return `#\`${rule.id}\` (keywords): ${rule.keywords.join(', ')}`;
			}
			return `#\`${rule.id}\` (invalid)`;
		});
		if (message.length === 0) {
			message.push('no rules found');
		}
		await bot.sendMessage({
			chatId,
			text: message.join('\n'),
		});
		return;
	}

	if (command === '/remove_rule') {
		const id = parseInt(args[0], 10);

		if (isNaN(id)) {
			await bot.sendMessage({
				chatId,
				text: 'invalid id',
			});
			return;
		}

		const rules = rulestorage.data[chatId] || [];
		const newRules = rules.filter((rule) => rule.id !== id);
		rulestorage.data[chatId] = newRules;
		await env.DATA.put('rules', JSON.stringify(rulestorage));
		await bot.sendMessage({
			chatId,
			text: `rule removed: ${id}`,
		});
		return;
	}

	if (command === '/fetch_now') {
		const rules = rulestorage.data[chatId] || [];
		if (rules.length === 0) {
			await bot.sendMessage({
				chatId,
				text: 'no rules found',
			});
			return;
		}

		const length = parseInt(args[0], 10) || 7;
		const date_limit = Date.now() / 1000 - 24 * 60 * 60 * length;
		const data = await fetchRecentPosts(0, date_limit);

		for (const post of data) {
			if (matchRules(rules, post.text)) {
				await bot.sendMessage({
					chatId,
					text: post.link,
				});
			}
		}
		return;
	}

	await bot.sendMessage({
		chatId,
		text: 'invalid command',
	});
}

async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	// auth. this time check headers
	const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
	if (secret !== env.ENV_BOT_SECRET) {
		return new Response('invalid secret', { status: 403 });
	}

	const body = await request.json();

	// console.log(JSON.stringify(body, null, 2));
	// const bot = new TelegramAPI({ botToken: env.ENV_BOT_TOKEN });
	// bot.fowardMessage({
	// 	chatId: env.ENV_BOT_ADMIN_CHAT_ID,
	// 	fromChatId: body.message.chat.id,
	// 	messageId: body.message.message_id,
	// });

	if ('message' in body) {
		const message = body.message;
		if ('text' in message) {
			await handleMessageText(env, message.chat.id.toString(), message.text);
			return new Response('ok');
		}
	}

	return new Response('not implemented', { status: 501 });
}

async function fowardJob(env: Env): Promise<Response> {
	const rulestorage = (await env.DATA.get('rules').then((r) => (r ? JSON.parse(r) : { data: {} }))) as RuleStorage;
	if (!rulestorage.data) {
		return new Response('no rules found', { status: 404 });
	}

	const bot = new TelegramAPI({ botToken: env.ENV_BOT_TOKEN });
	const lastUpdated = await env.DATA.get('lastUpdated');
	// string | null -> number | null
	const lastUpdatedNumber = lastUpdated ? parseInt(lastUpdated, 10) : null;
	const data = await fetchRecentPosts(0, lastUpdatedNumber);

	for (const post of data) {
		for (const chatId in rulestorage.data) {
			if (matchRules(rulestorage.data[chatId], post.text)) {
				await bot.sendMessage({
					chatId,
					text: post.link,
				});
			}
		}
	}

	// update lastUpdated
	await env.DATA.put('lastUpdated', (Date.now() / 1000).toString());
	return new Response('ok');
}

export default {
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		await fowardJob(env);
	},

	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const path = new URL(request.url).pathname;
		if (path === '/setWebhook') {
			return setWebhook(request, env, ctx);
		}
		if (path === '/unsetWebhook') {
			return unsetWebhook(request, env, ctx);
		}
		if (path === '/webhook') {
			return handleWebhook(request, env, ctx);
		}
		if (path === '/fowardJob') {
			return fowardJob(env);
		}

		return new Response('not found', { status: 404 });
	},
};
