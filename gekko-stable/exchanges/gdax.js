var Gdax = require('gdax');
var util = require('../core/util.js');
var _ = require('lodash');
var moment = require('moment');
var log = require('../core/log');

var batchSize = 100;

var Trader = function(config) {
    _.bindAll(this);

    this.post_only = false; // orders can be rejected because of this
    this.use_sandbox = false;
    this.name = 'GDAX';
    this.import = false;
    this.scanback = false;
    this.scanbackTid = 0;
    this.scanbackResults = [];

    if(_.isObject(config)) {
        this.key = config.key;
        this.secret = config.secret;
        this.passphrase = config.passphrase;

        this.pair = [config.asset, config.currency].join('-').toUpperCase();
        this.use_sandbox = config.sandbox ? config.sandbox : false;
        this.post_only = config.post_only ? config.post_only : false;
    }

    this.gdax_public = new Gdax.PublicClient(this.pair, this.use_sandbox ? 'https://api-public.sandbox.gdax.com' : undefined);
    this.gdax = new Gdax.AuthenticatedClient(this.key, this.secret, this.passphrase, this.use_sandbox ? 'https://api-public.sandbox.gdax.com' : undefined);
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
    var result = function(err, response, data) {
        if (data.hasOwnProperty('message')) {
            return callback(data.message, []);
        }
        var portfolio = data.map(function (account) {
                return {
                    name: account.currency.toUpperCase(),
                    amount: parseFloat(account.available)
                }
            }
        );
        callback(err, portfolio);
    };

    this.gdax.getAccounts(result);
}

Trader.prototype.getTicker = function(callback) {
    var result = function(err, response, data) {
        callback(err, {bid: +data.bid, ask: +data.ask})
    };

    this.gdax_public.getProductTicker(result);
}

Trader.prototype.getFee = function(callback) {
    //https://www.gdax.com/fees
    //There is no maker fee, not sure if we need taker fee here
    //If post only is enabled, gdax only does maker trades which are free
    callback(false, this.post_only ? 0 : 0.0025);
}

Trader.prototype.buy = function(amount, price, callback) {
    var buyParams = {
        'price': price,
        'size': amount,
        'product_id': this.pair,
        'post_only': this.post_only
    };
    var result = function(err, response, data) {
        if (data.hasOwnProperty('message')) {
            return callback(data.message, null);
        }
        callback(err, data.id);
    };

    this.gdax.buy(buyParams, result);
}

Trader.prototype.sell = function(amount, price, callback) {
    var sellParams = {
        'price': price,
        'size': amount,
        'product_id': this.pair,
        'post_only': this.post_only
    };
    var result = function(err, response, data) {
        if (data.hasOwnProperty('message')) {
            return callback(data.message, null);
        }
        callback(err, data.id);
    };

    this.gdax.sell(sellParams, result);
}

Trader.prototype.checkOrder = function(order, callback) {

    if (order == null) {
        return callback('EMPTY ORDER_ID', false);
    }

    var result = function(err, response, data) {
        if (data.hasOwnProperty('message')) {
            return callback(data.message, null);
        }

        var status = data.status;
        if (status == 'done') {
            return callback(err, true);
        } else if (status == 'rejected') {
            return callback(err, false);
        } else if (status == 'pending') {
            return callback(err, false);
        }
        callback(err, false);
    };

    this.gdax.getOrder(order, result);
}

Trader.prototype.cancelOrder = function(order) {
    if (order == null) {
        return;
    }

    var result = function(err, response, data) {
        //
    };

    this.gdax.cancelOrder(order, result);
}

Trader.prototype.getTrades = function(since, callback, descending) {
    var args = _.toArray(arguments);
    var lastScan = 0;

    var process = function(err, response, data) {
        if(err)
            return this.retry(this.getTrades, args);

        var result = _.map(data, function(trade) {
            return {
                tid: trade.trade_id,
                amount: parseFloat(trade.size),
                date: moment.utc(trade.time).format('X'),
                price: parseFloat(trade.price)
            };
        });

        if (this.scanback) {
            var last = _.last(data);
            var first = _.first(data);

            // Try to find trade id matching the since date
            if (!this.scanbackTid) {
                // either scan for new ones or we found it.
                if (moment.utc(last.time) < moment.utc(since)) {
                    this.scanbackTid = last.trade_id;
                } else {
                    log.debug('Scanning backwards...' + last.time);
                    this.gdax_public.getProductTrades({after: last.trade_id - (batchSize * lastScan) , limit: batchSize}, process);
                    lastScan++;
                    if (lastScan > 100) {
                        lastScan = 10;
                    }
                }
            }

            if (this.scanbackTid) {
            // if scanbackTid is set we need to move forward again
                log.debug('Backwards: ' + last.time + ' (' + last.trade_id + ') to ' + first.time + ' (' + first.trade_id + ')');

                if (this.import) {
                    this.scanbackTid = first.trade_id;
                    callback(null, result.reverse());
                } else {
                    this.scanbackResults = this.scanbackResults.concat(result.reverse());

                    if (this.scanbackTid != first.trade_id) {
                        this.scanbackTid = first.trade_id;
                        this.gdax_public.getProductTrades({after: this.scanbackTid + batchSize + 1, limit: batchSize}, process);
                    } else {
                        this.scanback = false;
                        this.scanbackTid = 0;
                        if (!this.import) {
                            log.debug('Scan finished: data found:' + this.scanbackResults.length);
                            callback(null, this.scanbackResults);
                        }
                        this.scanbackResults = [];
                    }
                }
            }
        } else {
            callback(null, result.reverse());
        }
    }.bind(this);

    if (since || this.scanback) {
        this.scanback = true;
        if (this.scanbackTid) {
            this.gdax_public.getProductTrades({after: this.scanbackTid + batchSize + 1, limit: batchSize}, process);
        } else {
            log.debug('Scanning back in the history needed...');
            log.debug(moment.utc(since).format());
            this.gdax_public.getProductTrades({limit: batchSize}, process);
        }
    } else {
        this.gdax_public.getProductTrades({limit: batchSize}, process);
    }

}


module.exports = Trader;