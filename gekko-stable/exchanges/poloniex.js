var Poloniex = require("poloniex.js");
var util = require('../core/util.js');
var _ = require('lodash');
var moment = require('moment');
var log = require('../core/log');

// Helper methods
function joinCurrencies(currencyA, currencyB){
    return currencyA + '_' + currencyB;
}

var Trader = function(config) {
  _.bindAll(this);
  if(_.isObject(config)) {
    this.key = config.key;
    this.secret = config.secret;
    this.currency = config.currency;
    this.asset = config.asset;
  }
  this.name = 'Poloniex';
  this.balance;
  this.price;

  this.pair = [this.currency, this.asset].join('_');

  this.poloniex = new Poloniex(this.key, this.secret);
}

// if the exchange errors we try the same call again after
// waiting 10 seconds
Trader.prototype.retry = function(method, args) {
  var wait = +moment.duration(10, 'seconds');
  log.debug(this.name, 'returned an error, retrying..');

  var self = this;

  // make sure the callback (and any other fn)
  // is bound to Trader
  _.each(args, function(arg, i) {
    if(_.isFunction(arg))
      args[i] = _.bind(arg, self);
  });

  // run the failed method again with the same
  // arguments after wait
  setTimeout(
    function() { method.apply(self, args) },
    wait
  );
}

Trader.prototype.getPortfolio = function(callback) {
  var args = _.toArray(arguments);
  var set = function(err, data) {
    if(err)
      return this.retry(this.getPortfolio, args);

    var assetAmount = parseFloat( data[this.asset] );
    var currencyAmount = parseFloat( data[this.currency] );

    if(!_.isNumber(assetAmount) || !_.isNumber(currencyAmount)) {
      log.info('asset:', this.asset);
      log.info('currency:', this.currency);
      log.info('exchange data:', data);
      util.die('Gekko was unable to set the portfolio');
    }

    var portfolio = [
      { name: this.asset, amount: assetAmount },
      { name: this.currency, amount: currencyAmount }
    ];

    callback(err, portfolio);
  }.bind(this);

  this.poloniex.myBalances(set);
}

Trader.prototype.getTicker = function(callback) {
  var args = _.toArray(arguments);
  this.poloniex.getTicker(function(err, data) {
    if(err)
      return this.retry(this.getTicker, args);

    var tick = data[this.pair];

    callback(null, {
      bid: parseFloat(tick.highestBid),
      ask: parseFloat(tick.lowestAsk),
    });

  }.bind(this));
}

Trader.prototype.getFee = function(callback) {
  var set = function(err, data) {
    if(err || data.error)
      return callback(err || data.error);

    callback(false, parseFloat(data.takerFee));
  }
  this.poloniex._private('returnFeeInfo', _.bind(set, this));
}

Trader.prototype.buy = function(amount, price, callback) {
  var set = function(err, result) {
    if(err || result.error)
      return log.error('unable to buy:', err, result);

    callback(null, result.orderNumber);
  }.bind(this);

  this.poloniex.buy(this.currency, this.asset, price, amount, set);
}

Trader.prototype.sell = function(amount, price, callback) {
  var set = function(err, result) {
    if(err || result.error)
      return log.error('unable to sell:', err, result);

    callback(null, result.orderNumber);
  }.bind(this);

  this.poloniex.sell(this.currency, this.asset, price, amount, set);
}

Trader.prototype.checkOrder = function(order, callback) {
  var check = function(err, result) {
    var stillThere = _.find(result, function(o) { return o.orderNumber === order });
    callback(err, !stillThere);
  }.bind(this);

  this.poloniex.myOpenOrders(this.currency, this.asset, check);
}

Trader.prototype.cancelOrder = function(order, callback) {
  var cancel = function(err, result) {
    if(err || !result.success) {
      log.error('unable to cancel order', order, '(', err, result, ')');
    }
  }.bind(this);

  this.poloniex.cancelOrder(this.currency, this.asset, order, cancel);
}

Trader.prototype.getTrades = function(since, callback, descending) {

  var firstFetch = !!since;

  var args = _.toArray(arguments);
  var process = function(err, result) {
    if(err) {
      return this.retry(this.getTrades, args);
    }

    // Edge case, see here:
    // @link https://github.com/askmike/gekko/issues/479
    if(firstFetch && _.size(result) === 50000)
      util.die(
        [
          'Poloniex did not provide enough data. Read this:',
          'https://github.com/askmike/gekko/issues/479'
        ].join('\n\n')
      );

    result = _.map(result, function(trade) {
    	return {
        tid: trade.tradeID,
        amount: +trade.amount,
        date: moment.utc(trade.date).unix(),
        price: +trade.rate
      };
    });

    callback(null, result.reverse());
  };

  var params = {
    currencyPair: joinCurrencies(this.currency, this.asset)
  }

  if(since)
    params.start = since.unix();

  this.poloniex._public('returnTradeHistory', params, _.bind(process, this));
}


module.exports = Trader;
