const webpack = require('webpack');

module.exports = {
  externals : {
    moment: 'moment' // chart.js depends on moment, and thanks to this it will not be bundled
  }
};
