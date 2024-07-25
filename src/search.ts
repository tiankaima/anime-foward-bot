// API: https://search.acgn.es/api/?cid=1&page=0&limit=24&word=*&sort=time&file_suffix=

export interface Post {
	id: number;
	channel_id: number;
	channel_name: string;
	size: number;
	text: string;
	file_suffix: string;
	msg_id: number;
	supports_streaming: boolean;
	link: string;
	date: number;
}

export async function fetchRecentPosts(page: number, not_before?: number | null): Promise<Post[]> {
	if (page < 0 || page > 10) {
		return [];
	}

	if (not_before == null) {
		not_before = Date.now() / 1000 - 24 * 60 * 60;
	}

	const url = new URL(`https://search.acgn.es/api/?cid=1&page=${page}&limit=24&word=*&sort=time&file_suffix=`);

	const data = await fetch(url.toString())
		.then((res) => res.json())
		.then((res) => res.data);

	// calculate the time of the first post
	const firstPostTime = data.map((post: Post) => post.date).reduce((a: number, b: number) => Math.min(a, b));

	if (firstPostTime > not_before) {
		const nextData = await fetchRecentPosts(page + 1, not_before);
		return data.concat(nextData);
	}

	// filter out posts that are older than not_before
	return data.filter((post: Post) => post.date > not_before);
}
