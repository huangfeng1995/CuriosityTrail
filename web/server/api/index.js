const app = require('../vercel-server');

module.exports = async (req, res) => {
  return app(req, res);
};
