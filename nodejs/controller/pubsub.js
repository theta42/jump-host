'use strict';

const {EventEmitter} = require('events');

/**
 * In-process pub/sub with regex topic matching.
 *
 * The sibling apps use p2psub here, which exists to gossip between processes.
 * jump-host is a single process, so this is the same small API surface without
 * the dependency: subscribe(pattern, listener) / publish(topic, data).
 */
class PubSub {
	constructor(){
		this.bus = new EventEmitter();
		// A gateway with many concurrent sessions can legitimately have more
		// than the default ten listeners.
		this.bus.setMaxListeners(100);
		this.subscriptions = [];
	}

	subscribe(pattern, listener){
		const entry = {pattern, listener};
		this.subscriptions.push(entry);
		return {remove: () => {
			this.subscriptions = this.subscriptions.filter(e => e !== entry);
		}};
	}

	publish(topic, data){
		for(const {pattern, listener} of this.subscriptions){
			// Match against the pattern itself. Stringifying a RegExp and
			// rebuilding it treats the "/" delimiters as characters and
			// misplaces the anchors, which silently matches nothing —
			// @simpleworkjs/backend carried exactly that bug.
			const matches = pattern instanceof RegExp ? pattern.test(topic) : pattern === topic;
			if(!matches) continue;
			try{
				listener(data, topic);
			}catch(error){
				console.error('PubSub listener error:', error);
			}
		}
	}
}

module.exports = new PubSub();
