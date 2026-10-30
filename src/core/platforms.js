// The platforms an account posts to, and the slides each one takes.
//
// TikTok takes its own (9:16, 1080x1920) and Instagram its own (4:5, 1080x1350). A Facebook Page takes Instagram's: a
// Page's multi-photo post shows a portrait 4:5 image whole in the feed, and a third set of renders would cost a render
// of every slide for a picture no different from Instagram's. So nothing is ever rendered "for Facebook": a post's
// media has tiktok and instagram, and Facebook's part reads instagram's.

export const PLATFORM_LIST = ['tiktok', 'instagram', 'facebook'];

/** Each platform's rendered set. */
export const MEDIA_OF = { tiktok: 'tiktok', instagram: 'instagram', facebook: 'instagram' };

/** The rendered set a platform's part is sent from: 'tiktok' or 'instagram'. */
export const mediaOf = (platform) => MEDIA_OF[platform] || platform;

/** The sizes to render for a pack's platforms, each once: ['tiktok', 'facebook'] renders tiktok and instagram. */
export const mediaSizes = (platforms) => [...new Set((platforms || []).map(mediaOf))];

/**
 * A platform an account may leave unconnected without anything waiting on it: Facebook. A post goes to TikTok and
 * Instagram whether or not a Page is connected, so a missing Page is never a banner or an email asking to connect
 * (src/publish/hold.js). On an account whose only platform it is, it is needed like any other.
 */
export const OPTIONAL_PLATFORMS = ['facebook'];
