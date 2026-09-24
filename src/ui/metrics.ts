/** Row height in px — one number, used for both the CSS box and the arithmetic
 *  that decides how many rows fit, so the two cannot disagree. Its own module
 *  because every view that lays out rows needs it, and those views import
 *  each other. */
export const ROW_H = 21;
