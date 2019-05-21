(ns metabase.driver.presto-test
  (:require [clj-http.client :as http]
            [clojure.core.async :as a]
            [expectations :refer [expect]]
            [metabase.driver.presto :as presto]
            [metabase.test.util.async :as tu.async]))

;; make sure Presto query cancelation works
(expect
  '(http/delete
    "http://info.my-presto-instance.com/v1/query/MY_QUERY_ID"
    {:headers {"X-Presto-Source" "metabase", "X-Presto-User" nil, "X-Presto-Catalog" "hive"}})
  (let [details {:host "my-presto-instance.com", :port "8080", :catalog "hive", :ssl true}
        query   {}]
    (tu.async/with-open-channels [started-waiting-chan (a/promise-chan)
                                  cancel-request-chan  (a/promise-chan)
                                  error-chan           (a/promise-chan)]
      (with-redefs [http/post                    (constantly {:body {:nextUri "https://my-presto-instance.com?page=2"
                                                                     :id      "MY_QUERY_ID"
                                                                     :infoUri "http://info.my-presto-instance.com"}})
                    presto/presto-results        (constantly nil)
                    presto/fetch-presto-results! (fn [& _]
                                                   (a/>!! started-waiting-chan ::waiting-for-results)
                                                   (Thread/sleep 1000))
                    http/delete                  (fn [& args]
                                                   (a/>!! cancel-request-chan (cons 'http/delete args)))]
        (let [futur (future
                      (try (#'presto/execute-presto-query! details query)
                           (catch Throwable e
                             (a/>!! error-chan e))))]
          ;; wait until we get to the point that we're waiting for results
          (let [[result] (a/alts!! [started-waiting-chan error-chan (a/timeout 1000)])]
            (when (instance? Throwable result)
              (throw result)))
          ;; ok, now cancel the query and wait for the cancel request message
          (future-cancel futur)
          (first (a/alts!! [cancel-request-chan error-chan (a/timeout 1000)])))))))
