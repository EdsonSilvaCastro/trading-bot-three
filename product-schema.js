document.addEventListener("DOMContentLoaded", function () {
    function getFirstValidValue(...selectors) {
        for (let selector of selectors) {
            try {
                let value;
                if (typeof selector === 'function') {
                    value = selector();
                } else if (typeof selector === 'string') {
                    const el = document.querySelector(selector);
                    value = el?.textContent?.trim() || el?.src || el?.getAttribute('content');
                }
                if (value && value.trim && value.trim() !== '') return value.trim();
                if (value && typeof value === 'string' && value !== '') return value;
            } catch (e) {
                continue;
            }
        }
        return "";
    }

    function formatDateISO(dateStr) {
        if (!dateStr) return "";
        const match = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        return match ? `${match[3]}-${match[2]}-${match[1]}` : "";
    }

    const CONFIG = {
        MXN: { country: "MX", freeShipping: "599", shipping: "90" },
        CLP: { country: "CL", freeShipping: "29990", shipping: null }
    };
    const SELLER_NAME = "Petco México";

    const currency = document.querySelector('[itemprop="priceCurrency"]')?.getAttribute('content');
    const isOutOfStock = document.getElementById('is-out-of-stock-cedis')?.value === 'true';
    const ratingValue = document.getElementById("avgRating")?.textContent?.trim()?.replace(",", ".");
    const reviewCount = document.querySelector('.blue-header')?.textContent?.match(/\((\d+)\)/)?.[1] || "";

    const currencyConfig = CONFIG[currency] ?? CONFIG.CLP;

    const productData = {
        id: window.location.href,
        sku: document.querySelector('[itemprop="sku"]')?.textContent?.trim(),
        name: document.querySelector('.name span[itemprop="name"]')?.textContent?.trim(),
        brand: document.querySelector('[itemprop="brand"]')?.textContent?.trim(),
        currency: currency,
        image: getFirstValidValue(
            () => document.querySelector('.product-image-display img')?.src,
            () => document.querySelector('.image-gallery img')?.src
        ),
        description: document.querySelector('[itemprop="description"]')?.textContent?.trim(),
        gtin13: document.getElementById('vendorSKU')?.value?.trim(),
        priceWithoutDiscount: document.querySelector('#offer-schema-price')?.value || null,
        availability: isOutOfStock ? "OutOfStock" : "InStock",
        ratingValue: ratingValue,
        reviewCount: reviewCount,
        freeShippingMinimumAmount: currencyConfig.freeShipping,
        addressCountry: currencyConfig.country,
        shippingPrice: currencyConfig.shipping
    };

    const promoContainers = document.querySelectorAll('.aggregate-offer-promotion-entry');
    const easyBuyContainer = document.querySelector('.aggregate-offer-easybuy-entry');
    const hasPromo = promoContainers.length > 0 || easyBuyContainer !== null;

    let offers = null;

    if (!productData.priceWithoutDiscount) {
        offers = null;

    } else if (!hasPromo) {
        offers = {
            "@type": "Offer",
            "url": productData.id,
            "price": productData.priceWithoutDiscount,
            "priceCurrency": productData.currency,
            "itemCondition": "http://schema.org/NewCondition",
            "availability": "http://schema.org/" + productData.availability,
            "seller": {
                "@type": "Organization",
                "name": SELLER_NAME
            }
        };

    } else {
        const promoOffers = [];

        promoContainers.forEach((container) => {
            const enabled = container.querySelector('.aggregate-offer-promotion-schema-enabled')?.value?.trim();
            const title = container.querySelector('.aggregate-offer-promotion-schema-title')?.value?.trim();
            const description = container.querySelector('.aggregate-offer-promotion-schema-description')?.value?.trim();
            const discount = parseFloat(container.querySelector('.aggregate-offer-promotion-schema-discount')?.value);

            if (enabled !== 'true' || isNaN(discount) || discount <= 0) return;

            const promoPrice = (parseFloat(productData.priceWithoutDiscount) * (1 - discount / 100)).toFixed(2);

            promoOffers.push({
                "@type": "Offer",
                "price": promoPrice,
                "description": description || title,
                "priceSpecification": {
                    "@type": "UnitPriceSpecification",
                    "priceType": "https://schema.org/SalePrice"
                },
                "itemCondition": "http://schema.org/NewCondition",
                "availability": "http://schema.org/" + productData.availability,
                "seller": { "@type": "Organization", "name": SELLER_NAME }
            });
        });

        if (easyBuyContainer) {
            const enabled = easyBuyContainer.querySelector('.aggregate-offer-easybuy-promotion-schema-enabled')?.value?.trim();
            const title = easyBuyContainer.querySelector('.aggregate-offer-easybuy-promotion-schema-title')?.value?.trim();
            const description = easyBuyContainer.querySelector('.aggregate-offer-easybuy-promotion-schema-description')?.value?.trim();
            const price = easyBuyContainer.querySelector('.aggregate-offer-easybuy-promotion-schema-price')?.value?.trim();

            if (enabled === 'true' && price) {
                promoOffers.push({
                    "@type": "Offer",
                    "price": parseFloat(price).toFixed(2),
                    "description": description || title,
                    "priceSpecification": {
                        "@type": "UnitPriceSpecification",
                        "priceType": "https://schema.org/SalePrice"
                    },
                    "itemCondition": "http://schema.org/NewCondition",
                    "availability": "http://schema.org/" + productData.availability,
                    "seller": { "@type": "Organization", "name": SELLER_NAME }
                });
            }
        }

        if (promoOffers.length === 0) {
            offers = {
                "@type": "Offer",
                "url": productData.id,
                "price": productData.priceWithoutDiscount,
                "priceCurrency": productData.currency,
                "itemCondition": "http://schema.org/NewCondition",
                "availability": "http://schema.org/" + productData.availability,
                "seller": { "@type": "Organization", "name": SELLER_NAME }
            };
        } else {
            const allPrices = promoOffers.map(o => parseFloat(o.price));
            const lowPromoPrice = Math.min(...allPrices).toFixed(2);

            offers = {
                "@type": "AggregateOffer",
                "priceCurrency": productData.currency,
                "lowPrice": lowPromoPrice,
                "highPrice": productData.priceWithoutDiscount,
                "offerCount": promoOffers.length.toString(),
                "offers": promoOffers
            };
        }
    }

    const shippingDetails = [
        ...(productData.shippingPrice !== null ? [{
            "@type": "OfferShippingDetails",
            "shippingLabel": "Envío estándar",
            "shippingDestination": {
                "@type": "DefinedRegion",
                "addressCountry": productData.addressCountry
            },
            "shippingRate": {
                "@type": "MonetaryAmount",
                "value": productData.shippingPrice,
                "currency": productData.currency
            }
        }] : []),
        {
            "@type": "OfferShippingDetails",
            "shippingLabel": "Envío gratis",
            "shippingDestination": {
                "@type": "DefinedRegion",
                "addressCountry": productData.addressCountry
            },
            "shippingRate": {
                "@type": "MonetaryAmount",
                "value": "0",
                "currency": productData.currency
            },
            "eligibleTransactionVolume": {
                "@type": "PriceSpecification",
                "priceCurrency": productData.currency,
                "minPrice": productData.freeShippingMinimumAmount
            }
        }
    ];

    const merchantReturnPolicy = {
        "@type": "MerchantReturnPolicy",
        "applicableCountry": "MX",
        "returnPolicyCategory": "https://schema.org/MerchantReturnFiniteReturnWindow",
        "merchantReturnDays": 30,
        "returnMethod": "https://schema.org/ReturnByMail",
        "returnFees": "https://schema.org/FreeReturn"
    };

    const hasRating = reviewCount && Number(reviewCount) > 0 &&
        ratingValue && parseFloat(ratingValue) > 0;

    const schema = {
        "@context": "http://schema.org/",
        "@type": "Product",
        "@id": productData.id,
        "sku": productData.sku,
        "gtin13": productData.gtin13,
        "name": productData.name,
        "image": [productData.image],
        "brand": {
            "@type": "Brand",
            "name": productData.brand
        },
        "description": productData.description,
        "hasMerchantReturnPolicy": merchantReturnPolicy,
        "shippingDetails": shippingDetails,
        ...(offers && { offers }),
        ...(hasRating && {
            aggregateRating: {
                "@type": "AggregateRating",
                "ratingValue": productData.ratingValue,
                "reviewCount": productData.reviewCount
            }
        })
    };

    const schemaElement = document.getElementById('product-schema');
    schemaElement.textContent = JSON.stringify(schema);

    function extractReviews() {
        const reviewContainers = document.querySelectorAll('.review-entry');
        const reviews = [];

        reviewContainers.forEach((container, index) => {
            if (index >= 5) return;

            const author = container.querySelector('.review-schema-date-author')?.value?.trim();
            const dateRaw = container.querySelector('.review-schema-date-published')?.value?.trim();
            const reviewBody = container.querySelector('.review-schema-date-reviewbody')?.value?.trim();
            const name = container.querySelector('.review-schema-date-name')?.value?.trim();
            const rawRating = container.querySelector('.review-schema-date-rating')?.value;
            const rating = rawRating !== undefined ? parseFloat(rawRating).toString() : undefined;

            if (author && reviewBody && rating) {
                reviews.push({
                    "@type": "Review",
                    "author": author,
                    "datePublished": formatDateISO(dateRaw),
                    "reviewBody": reviewBody,
                    "name": name || "",
                    "reviewRating": {
                        "@type": "Rating",
                        "bestRating": "5",
                        "worstRating": "1",
                        "ratingValue": rating
                    }
                });
            }
        });

        return reviews;
    }

    const observerTimeout = setTimeout(() => observer.disconnect(), 10_000);

    const observer = new MutationObserver(function (mutations, obs) {
        const reviewContainers = document.querySelectorAll('.review-entry');

        if (reviewContainers.length > 0) {
            obs.disconnect();
            clearTimeout(observerTimeout);

            const reviews = extractReviews();
            if (reviews.length > 0) {
                schema.review = reviews;
                schemaElement.textContent = JSON.stringify(schema);
            }
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });
});
