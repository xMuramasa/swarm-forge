#!/usr/bin/env bb

;; CRAP score for any language `lizard` understands, from an lcov coverage report.
;;   crap.sh --lcov coverage/lcov.info [--threshold 10] <source file or dir> ...
;; CRAP = ccn^2 * (1 - coverage)^3 + ccn, per function. Prints the functions over the
;; threshold, worst first, and exits 1 when there are any.

(ns crap
  (:require [babashka.fs :as fs]
            [babashka.process :as process]
            [clojure.data.csv :as csv]
            [clojure.string :as str]))

(def default-threshold 10)

(defn normalize [path]
  (str (fs/normalize (fs/absolutize (str path)))))

(defn parse-lizard-csv
  "lizard --csv rows -> [{:file :name :ccn :start :end}]. Columns: nloc ccn token param length
   location file name long-name start end."
  [text]
  (vec (for [[_ ccn _ _ _ _ file name _ start end] (csv/read-csv text)
             :when (and file (re-matches #"\d+" (str ccn)))]
         {:file (normalize file) :name name :ccn (parse-long ccn)
          :start (parse-long start) :end (parse-long end)})))

(defn parse-lcov
  "lcov text -> {absolute-file {line hits}}, from the SF and DA records."
  [text]
  (loop [lines (str/split-lines text) file nil acc {}]
    (if-let [line (first lines)]
      (cond
        (str/starts-with? line "SF:")
        (let [f (normalize (subs line 3))]
          (recur (rest lines) f (update acc f #(or % {}))))

        (and file (str/starts-with? line "DA:"))
        (let [[n hits] (str/split (subs line 3) #",")]
          (recur (rest lines) file (assoc-in acc [file (parse-long n)] (parse-long hits))))

        :else (recur (rest lines) file acc))
      acc)))

(defn function-coverage
  "Share of the function's executable lines that ran. A file missing from the report was never
   loaded, so 0. A function with no executable lines (types, declarations) counts as covered."
  [coverage {:keys [file start end]}]
  (if-let [hits (get coverage file)]
    (let [in-range (filter (fn [[n _]] (<= start n end)) hits)]
      (if (empty? in-range)
        1.0
        (/ (count (filter (comp pos? val) in-range)) (double (count in-range)))))
    0.0))

(defn crap-score [ccn coverage]
  (+ (* ccn ccn (Math/pow (- 1.0 coverage) 3)) ccn))

(defn evaluate
  "Every function with its :coverage and :crap, worst first."
  [functions coverage]
  (->> functions
       (map (fn [f]
              (let [cov (function-coverage coverage f)]
                (assoc f :coverage cov :crap (crap-score (:ccn f) cov)))))
       (sort-by :crap >)
       vec))

(defn lizard-command []
  (if (zero? (:exit (process/sh {:continue true} "sh" "-c" "command -v lizard >/dev/null 2>&1")))
    ["lizard"]
    ["uvx" "lizard"]))

(defn run-lizard [paths]
  (let [result (apply process/sh {:continue true} (concat (lizard-command) ["--csv"] paths))]
    (when-not (zero? (:exit result))
      (binding [*out* *err*]
        (println "lizard failed:" (:err result)))
      (System/exit 2))
    (:out result)))

(defn parse-args [args]
  (loop [args args opts {:threshold default-threshold :paths []}]
    (if-let [arg (first args)]
      (case arg
        "--lcov" (recur (drop 2 args) (assoc opts :lcov (second args)))
        "--threshold" (recur (drop 2 args) (assoc opts :threshold (parse-double (second args))))
        (recur (rest args) (update opts :paths conj arg)))
      opts)))

(defn report-line [{:keys [crap ccn coverage file start name]}]
  (format "CRAP %6.1f  CCN %3d  COV %3d%%  %s:%d %s"
          crap ccn (long (* 100 coverage)) (fs/relativize (fs/cwd) file) start name))

(defn -main [& args]
  (let [{:keys [lcov threshold paths]} (parse-args args)]
    (when (or (nil? lcov) (empty? paths))
      (binding [*out* *err*]
        (println "Usage: crap.sh --lcov <lcov file> [--threshold 10] <source file or dir> ..."))
      (System/exit 2))
    (when-not (fs/regular-file? lcov)
      (binding [*out* *err*]
        (println "No coverage report at" lcov "- run the tests with lcov coverage first."))
      (System/exit 2))
    (let [scored (evaluate (parse-lizard-csv (run-lizard paths)) (parse-lcov (slurp lcov)))
          over (filter #(> (:crap %) threshold) scored)]
      (println (str (count scored) " functions, " (count over) " over CRAP " threshold))
      (doseq [f over]
        (println (report-line f)))
      (System/exit (if (seq over) 1 0)))))

(when (= (str *file*) (System/getProperty "babashka.file"))
  (apply -main *command-line-args*))
