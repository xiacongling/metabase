(ns metabase.driver.presto-test
  (:require [expectations :refer [expect]]
            [clj-http.client :as http]
            [metabase.driver.presto :as presto]
            [clojure.core.async :as a]
            [metabase.test.util.async :as tu.async]))

;; make sure Presto query cancelation works
(defn- x []
  (let [details {:host "my-presto-instance.com", :port "8080", :catalog "hive"}
        query   {}]
    (tu.async/with-open-channels [started-waiting-chan (a/promise-chan)
                                  cancel-request-chan  (a/promise-chan)
                                  error-chan           (a/promise-chan)]
      (with-redefs [http/post                    (constantly {:body {:nextUri "my-presto-instance.com?page=2"
                                                                     :id      "MY_QUERY_ID"
                                                                     :infoUri "info.my-presto-instance.com"}})
                    presto/presto-results        (constantly nil)
                    presto/fetch-presto-results! (fn [& _]
                                                   (println "Started waiting:") ; NOCOMMIT
                                                   (a/>!! started-waiting-chan ::waiting-for-results)
                                                   (Thread/sleep 1000))
                    http/delete                  (fn [& args]
                                                   (println "CANCEL ARGS" args) ; NOCOMMIT
                                                   (a/>!! cancel-request-chan args))]
        (let [futur (future
                      (try (#'presto/execute-presto-query! details query)
                           (catch Throwable e
                             (println "e:" e) ; NOCOMMIT
                             (a/>!! error-chan e))))]
          ;; wait until we get to the point that we're waiting for results
          (let [[result] (a/alts!! [started-waiting-chan error-chan (a/timeout 1000)])]
            (when (instance? Throwable result)
              (throw result)))
          ;; ok, now cancel the query and wait for the cancel request message
          (future-cancel futur)
          (first (a/alts!! [cancel-request-chan error-chan (a/timeout 1000)])))))))
