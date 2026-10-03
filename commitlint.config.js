export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Agent-written bodies and Co-Authored-By trailers exceed 100 characters.
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
};
